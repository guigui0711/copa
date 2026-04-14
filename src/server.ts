/**
 * Copa proxy server.
 *
 * Transparent Anthropic Messages API proxy that injects Copilot auth.
 * Claude Code sends requests here, we forward to Copilot's /v1/messages
 * endpoint with proper auth headers. Responses (including SSE streams)
 * are passed through unmodified — preserving real cache token counts.
 */

import { Hono } from "hono";
import { getCopilotToken, clearCopilotToken } from "./copilot-token.js";
import { getStoredToken } from "./auth.js";

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

/** Headers to NOT forward from the upstream response */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "content-encoding",
]);

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

    // Read the raw request body
    const body = await c.req.raw.arrayBuffer();

    // Build upstream headers: Copilot auth + required headers + client's extra headers
    const upstreamHeaders: Record<string, string> = {
      Authorization: `Bearer ${copilot.token}`,
      "Content-Type": "application/json",
      ...COPILOT_HEADERS,
    };

    // Forward select client headers (e.g., anthropic-version, anthropic-beta)
    for (const [key, value] of c.req.raw.headers.entries()) {
      if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase()) && !upstreamHeaders[key]) {
        // Forward anthropic-specific headers
        if (key.toLowerCase().startsWith("anthropic-")) {
          upstreamHeaders[key] = value;
        }
      }
    }

    // Forward to Copilot's /v1/messages endpoint
    const upstreamUrl = `${copilot.apiBase}/v1/messages`;
    let upstreamRes: Response;

    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body,
      });
    } catch (err) {
      // Network error — clear token cache in case it's a DNS/auth issue
      clearCopilotToken();
      return c.json(
        { type: "error", error: { type: "api_error", message: `Upstream request failed: ${err}` } },
        502,
      );
    }

    // If upstream returned auth error, clear cached token
    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
      clearCopilotToken();
    }

    // Build response headers — pass through most upstream headers
    const responseHeaders = new Headers();
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    // If streaming (SSE), pipe the stream directly
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

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    // Non-streaming: pass through the response body
    const responseBody = await upstreamRes.arrayBuffer();
    return new Response(responseBody, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
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

      const responseHeaders = new Headers();
      for (const [key, value] of res.headers.entries()) {
        if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
          responseHeaders.set(key, value);
        }
      }

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
