/**
 * Copa proxy server.
 *
 * Transparent Anthropic Messages API proxy that injects Copilot auth.
 * Claude Code sends requests here, we forward to Copilot's /v1/messages
 * endpoint with proper auth headers. Responses (including SSE streams)
 * are passed through unmodified — preserving real cache token counts.
 *
 * Auto-patches unsupported parameters (beta flags, effort levels, etc.)
 * by retrying failed requests with corrected values.
 */

import { Hono } from "hono";
import {
  getCopilotToken,
  clearCopilotToken,
  refreshCopilotTokenIfNeeded,
} from "./copilot-token.js";
import { getStoredToken } from "./auth.js";
import { log } from "./logger.js";

/** Idle timeout for SSE streams — if no data received for this long, abort */
const STREAM_IDLE_TIMEOUT_MS = 120_000; // 2 minutes

export const DEFAULT_PORT = 4141;

/** Headers required by the Copilot API */
const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-edits",
};

/** Headers to NOT forward from the client request */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "authorization",
  "content-length",
  "connection",
  "transfer-encoding",
]);

/** Beta flags that Copilot does not support — stripped from anthropic-beta header */
const UNSUPPORTED_BETA_FLAGS: RegExp[] = [
  /^context-\d/,       // e.g. context-1m-2025-08-07
];

/** Headers to NOT forward from the upstream response */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "content-encoding",
]);

// ---------------------------------------------------------------------------
// Model capability cache — remember what each model doesn't support
// ---------------------------------------------------------------------------
// After a 400 error is successfully patched, we record the fix so future
// requests for the same model are patched proactively (no trial-and-error).

interface ModelPatches {
  /** e.g. { effort: "medium" } — values to override in output_config */
  effortOverride?: string;
  /** Top-level body fields to remove */
  removedFields: Set<string>;
  /** Nested fields to remove, keyed by parent (e.g. "output_config.effort") */
  removedNestedFields: Set<string>;
  /** Beta flags to strip */
  removedBetaFlags: Set<string>;
}

const modelPatchCache = new Map<string, ModelPatches>();

function getModelPatches(model: string): ModelPatches {
  let patches = modelPatchCache.get(model);
  if (!patches) {
    patches = {
      removedFields: new Set(),
      removedNestedFields: new Set(),
      removedBetaFlags: new Set(),
    };
    modelPatchCache.set(model, patches);
  }
  return patches;
}

/** Apply cached patches to body and headers before sending the request */
function applyCachedPatches(
  model: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string>,
): boolean {
  const patches = modelPatchCache.get(model);
  if (!patches) return false;

  let applied = false;

  if (body) {
    // Apply effort override
    if (patches.effortOverride) {
      const config = body.output_config as Record<string, unknown> | undefined;
      if (config && config.effort && config.effort !== patches.effortOverride) {
        config.effort = patches.effortOverride;
        applied = true;
      }
    }

    // Remove known unsupported top-level fields
    for (const field of patches.removedFields) {
      if (field in body) {
        delete body[field];
        applied = true;
      }
    }

    // Remove known unsupported nested fields
    for (const nested of patches.removedNestedFields) {
      const [parent, child] = nested.split(".");
      const obj = body[parent] as Record<string, unknown> | undefined;
      if (obj && child in obj) {
        delete obj[child];
        applied = true;
      }
    }
  }

  // Strip known unsupported beta flags
  if (patches.removedBetaFlags.size > 0 && headers["anthropic-beta"]) {
    const flags = headers["anthropic-beta"].split(",").map((s) => s.trim());
    const filtered = flags.filter((f) => !patches.removedBetaFlags.has(f));
    if (filtered.length !== flags.length) {
      if (filtered.length > 0) {
        headers["anthropic-beta"] = filtered.join(", ");
      } else {
        delete headers["anthropic-beta"];
      }
      applied = true;
    }
  }

  if (applied) {
    log.info(`applied cached patches for model=${model}`);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Error-driven body patchers
// ---------------------------------------------------------------------------
// Each patcher inspects a 400 error message and returns a patched body JSON
// if it can fix the issue, or null if it doesn't apply.
// Now also records patches into the model cache.

type BodyPatcher = (errorMsg: string, body: Record<string, unknown>, model: string) => boolean;

const BODY_PATCHERS: BodyPatcher[] = [
  // Handle: "output_config.effort "xhigh" is not supported by model X; supported values: [medium]"
  (errorMsg, body, model) => {
    const match = errorMsg.match(/output_config\.effort "(\w+)" is not supported.*supported values: \[([^\]]+)\]/);
    if (!match) return false;
    const supported = match[2].split(",").map((s) => s.trim());
    const preference = ["xhigh", "high", "medium", "low"];
    const best = preference.find((e) => supported.includes(e)) ?? supported[0];
    const config = (body.output_config ?? {}) as Record<string, unknown>;
    log.info(`patching effort "${config.effort}" → "${best}" (cached for ${model})`);
    config.effort = best;
    body.output_config = config;
    // Cache the fix
    getModelPatches(model).effortOverride = best;
    return true;
  },

  // Handle: "X is not supported by model Y" — generic field removal
  (errorMsg, body, model) => {
    const match = errorMsg.match(/"?(\w+)"? is not supported by model/);
    if (!match) return false;
    const field = match[1];
    if (field in body) {
      log.info(`removing unsupported field "${field}" from body (cached for ${model})`);
      delete body[field];
      getModelPatches(model).removedFields.add(field);
      return true;
    }
    for (const key of ["output_config", "thinking", "reasoning"]) {
      const nested = body[key] as Record<string, unknown> | undefined;
      if (nested && field in nested) {
        log.info(`removing unsupported field "${key}.${field}" from body (cached for ${model})`);
        delete nested[field];
        getModelPatches(model).removedNestedFields.add(`${key}.${field}`);
        return true;
      }
    }
    return false;
  },
];

// Header-level patcher for beta flag errors
function patchBetaHeaders(
  errorMsg: string,
  headers: Record<string, string>,
  model: string,
): boolean {
  // Handle: "unsupported beta header(s): context-1m-2025-08-07"
  const match = errorMsg.match(/unsupported beta header\(s\): (.+)/);
  if (!match) return false;
  const unsupported = match[1].split(",").map((s) => s.trim());
  const current = headers["anthropic-beta"];
  if (!current) return false;
  const filtered = current
    .split(",")
    .map((s) => s.trim())
    .filter((flag) => !unsupported.includes(flag));
  if (filtered.length > 0) {
    headers["anthropic-beta"] = filtered.join(", ");
  } else {
    delete headers["anthropic-beta"];
  }
  log.info(`removed unsupported beta flags: ${unsupported.join(", ")} (cached for ${model})`);
  // Cache
  const patches = getModelPatches(model);
  for (const flag of unsupported) patches.removedBetaFlags.add(flag);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUpstreamHeaders(
  copilotToken: string,
  clientHeaders: Headers,
): Record<string, string> {
  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    "Content-Type": "application/json",
    ...COPILOT_HEADERS,
  };

  for (const [key, value] of clientHeaders.entries()) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase()) || upstreamHeaders[key]) continue;

    if (key.toLowerCase() === "anthropic-beta") {
      const supported = value
        .split(",")
        .map((s) => s.trim())
        .filter((flag) => !UNSUPPORTED_BETA_FLAGS.some((re) => re.test(flag)));
      if (supported.length > 0) {
        upstreamHeaders[key] = supported.join(", ");
      }
    } else if (key.toLowerCase().startsWith("anthropic-")) {
      upstreamHeaders[key] = value;
    }
  }

  return upstreamHeaders;
}

function buildResponseHeaders(upstreamRes: Response): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }
  return responseHeaders;
}

const MAX_RETRIES = 3;

/** Format an error as an SSE event that Claude Code can interpret */
function formatSSEError(message: string): string {
  const errorData = JSON.stringify({
    type: "error",
    error: { type: "api_error", message },
  });
  return `event: error\ndata: ${errorData}\n\n`;
}

export function createApp(): Hono {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

  // Models endpoint — passthrough to Copilot
  app.get("/v1/models", async (c) => {
    const githubToken = getStoredToken();
    if (!githubToken) {
      return c.json({ error: "Not logged in. Run `copa login` first." }, 401);
    }

    try {
      const copilot = await getCopilotToken(githubToken);
      const res = await fetch(`${copilot.apiBase}/models`, {
        headers: {
          Authorization: `Bearer ${copilot.token}`,
          ...COPILOT_HEADERS,
        },
      });

      const data = await res.json();
      return c.json(data, res.status as 200);
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  // Main proxy: Anthropic Messages API
  app.post("/v1/messages", async (c) => {
    const startTime = Date.now();
    const githubToken = getStoredToken();
    if (!githubToken) {
      return c.json(
        { type: "error", error: { type: "authentication_error", message: "Not logged in. Run `copa login` first." } },
        401,
      );
    }

    let copilot;
    try {
      copilot = await getCopilotToken(githubToken);
    } catch (err) {
      clearCopilotToken();
      return c.json(
        { type: "error", error: { type: "authentication_error", message: String(err) } },
        401,
      );
    }

    // Parse request body
    const rawBody = await c.req.raw.arrayBuffer();
    let bodyJson: Record<string, unknown> | null = null;
    try {
      bodyJson = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      // Not valid JSON — forward as-is
    }

    const model = bodyJson?.model as string | undefined ?? "unknown";
    const isStream = bodyJson?.stream === true;
    log.info(`→ POST /v1/messages model=${model} stream=${isStream}`);

    const upstreamHeaders = buildUpstreamHeaders(copilot.token, c.req.raw.headers);

    // Apply cached patches proactively (avoid trial-and-error for known issues)
    applyCachedPatches(model, bodyJson, upstreamHeaders);
    const upstreamUrl = `${copilot.apiBase}/v1/messages`;

    // Retry loop: send request, if 400 try to auto-patch and retry
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Proactively refresh token if close to expiry (avoid mid-stream expiry)
      if (attempt === 0) {
        try {
          await refreshCopilotTokenIfNeeded(githubToken);
          const freshCopilot = await getCopilotToken(githubToken);
          upstreamHeaders.Authorization = `Bearer ${freshCopilot.token}`;
        } catch {
          // Non-fatal — proceed with existing token
        }
      }

      const bodyToSend = bodyJson ? JSON.stringify(bodyJson) : rawBody;

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: bodyToSend,
        });
      } catch (err) {
        clearCopilotToken();
        return c.json(
          { type: "error", error: { type: "api_error", message: `Upstream request failed: ${err}` } },
          502,
        );
      }

      // Log non-success status
      if (upstreamRes.status >= 400) {
        log.warn(`← ${upstreamRes.status} from upstream (attempt ${attempt + 1}, ${Date.now() - startTime}ms)`);
      }

      // If upstream returned auth error, clear cached token
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        clearCopilotToken();
      }

      // On 400, try to auto-patch the request and retry
      if (upstreamRes.status === 400 && attempt < MAX_RETRIES) {
        const errorBody = await upstreamRes.text();
        let errorMsg = "";
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed?.error?.message ?? "";
        } catch {
          errorMsg = errorBody;
        }

        if (errorMsg) {
          let patched = false;

          // Try header-level patches
          patched = patchBetaHeaders(errorMsg, upstreamHeaders, model) || patched;

          // Try body-level patches
          if (bodyJson) {
            for (const patcher of BODY_PATCHERS) {
              patched = patcher(errorMsg, bodyJson, model) || patched;
            }
          }

          if (patched) {
            log.warn(`retrying request (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
            continue; // retry with patched request
          }
        }

        // Can't patch — return the error as-is
        const responseHeaders = buildResponseHeaders(upstreamRes);
        return new Response(errorBody, {
          status: upstreamRes.status,
          headers: responseHeaders,
        });
      }

      // Success or non-400 error — return the response
      const responseHeaders = buildResponseHeaders(upstreamRes);

      if (upstreamRes.headers.get("content-type")?.includes("text/event-stream")) {
        if (!upstreamRes.body) {
          return c.json(
            { type: "error", error: { type: "api_error", message: "Empty stream from upstream" } },
            502,
          );
        }

        responseHeaders.set("content-type", "text/event-stream");
        responseHeaders.set("cache-control", "no-cache");
        responseHeaders.set("connection", "keep-alive");

        log.request("POST", "/v1/messages", upstreamRes.status, Date.now() - startTime, `model=${model} stream=start`);

        // Wrap the upstream stream with error handling and idle timeout
        const upstream = upstreamRes.body;
        const wrappedStream = new ReadableStream({
          async start(controller) {
            const reader = upstream.getReader();
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            let closed = false;

            const cleanup = () => {
              closed = true;
              if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
              }
            };

            const resetIdleTimer = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                if (closed) return;
                cleanup();
                log.error(`stream idle timeout (${STREAM_IDLE_TIMEOUT_MS / 1000}s), aborting`);
                try {
                  const errorEvent = formatSSEError("Stream idle timeout — no data received for " + (STREAM_IDLE_TIMEOUT_MS / 1000) + "s");
                  controller.enqueue(new TextEncoder().encode(errorEvent));
                  controller.close();
                } catch {
                  // Controller may already be closed
                }
                reader.cancel().catch(() => {});
              }, STREAM_IDLE_TIMEOUT_MS);
            };

            resetIdleTimer();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  cleanup();
                  log.info(`← stream complete (${Date.now() - startTime}ms) model=${model}`);
                  try { controller.close(); } catch { /* already closed */ }
                  break;
                }
                if (closed) break; // client disconnected
                resetIdleTimer();
                try {
                  controller.enqueue(value);
                } catch {
                  // Client disconnected — controller is closed
                  cleanup();
                  log.info(`← client disconnected (${Date.now() - startTime}ms) model=${model}`);
                  reader.cancel().catch(() => {});
                  break;
                }
              }
            } catch (err) {
              cleanup();
              const msg = String(err);
              if (msg.includes("Controller is already closed") || msg.includes("ERR_INVALID_STATE")) {
                log.info(`← client disconnected (${Date.now() - startTime}ms) model=${model}`);
              } else {
                log.error(`stream error: ${msg}`);
                try {
                  const errorEvent = formatSSEError(`Stream interrupted: ${err}`);
                  controller.enqueue(new TextEncoder().encode(errorEvent));
                  controller.close();
                } catch {
                  // Controller may already be closed
                }
              }
            }
          },
        });

        return new Response(wrappedStream, {
          status: upstreamRes.status,
          headers: responseHeaders,
        });
      }

      const responseBody = await upstreamRes.arrayBuffer();
      log.request("POST", "/v1/messages", upstreamRes.status, Date.now() - startTime, `model=${model}`);
      return new Response(responseBody, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    // Should not reach here, but safety net
    return c.json(
      { type: "error", error: { type: "api_error", message: "Max retries exceeded" } },
      502,
    );
  });

  // Token counting endpoint — passthrough
  app.post("/v1/messages/count_tokens", async (c) => {
    const githubToken = getStoredToken();
    if (!githubToken) {
      return c.json({ error: "Not logged in. Run `copa login` first." }, 401);
    }

    try {
      const copilot = await getCopilotToken(githubToken);
      const body = await c.req.raw.arrayBuffer();

      const res = await fetch(`${copilot.apiBase}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${copilot.token}`,
          "Content-Type": "application/json",
          ...COPILOT_HEADERS,
        },
        body,
      });

      const responseHeaders = buildResponseHeaders(res);
      const responseBody = await res.arrayBuffer();
      return new Response(responseBody, {
        status: res.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  // Catch-all for unknown routes
  app.all("*", (c) => {
    return c.json(
      { type: "error", error: { type: "not_found_error", message: `Unknown endpoint: ${c.req.method} ${c.req.path}` } },
      404,
    );
  });

  return app;
}
