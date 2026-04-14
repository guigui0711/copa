import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the external dependencies (auth + copilot-token) that the server imports,
// while testing the Hono app routing logic with real HTTP requests via app.request().

vi.mock("./auth.js", () => ({
  getStoredToken: vi.fn(),
}));

vi.mock("./copilot-token.js", () => ({
  getCopilotToken: vi.fn(),
  clearCopilotToken: vi.fn(),
}));

import { createApp } from "./server.js";
import { getStoredToken } from "./auth.js";
import { getCopilotToken, clearCopilotToken } from "./copilot-token.js";

const mockGetStoredToken = vi.mocked(getStoredToken);
const mockGetCopilotToken = vi.mocked(getCopilotToken);
const mockClearCopilotToken = vi.mocked(clearCopilotToken);

// Setup temp config dir so config.ts doesn't touch real filesystem
let tempDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.COPA_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "copa-server-test-"));
  process.env.COPA_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.COPA_CONFIG_DIR;
  } else {
    process.env.COPA_CONFIG_DIR = originalEnv;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function makeCopilotToken() {
  return {
    token: "copilot_test_token",
    expiresAt: Math.floor(Date.now() / 1000) + 1800,
    apiBase: "https://api.individual.githubcopilot.com",
  };
}

describe("server", () => {
  describe("GET /health", () => {
    test("returns ok status", async () => {
      const app = createApp();
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok", version: "0.1.0" });
    });
  });

  describe("GET /v1/models", () => {
    test("returns 401 when not logged in", async () => {
      mockGetStoredToken.mockReturnValue(null);
      const app = createApp();
      const res = await app.request("/v1/models");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Not logged in");
    });

    test("proxies models request to Copilot API", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const modelsResponse = {
        data: [
          { id: "claude-sonnet-4", object: "model" },
          { id: "gpt-4o", object: "model" },
        ],
      };

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(modelsResponse), { status: 200 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/models");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(2);
        expect(body.data[0].id).toBe("claude-sonnet-4");

        // Verify upstream request
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.individual.githubcopilot.com/models");
        expect(opts.headers.Authorization).toBe("Bearer copilot_test_token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns 502 when Copilot token exchange fails", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockRejectedValue(new Error("Token exchange failed"));

      const app = createApp();
      const res = await app.request("/v1/models");
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Token exchange failed");
    });
  });

  describe("POST /v1/messages", () => {
    test("returns 401 when not logged in", async () => {
      mockGetStoredToken.mockReturnValue(null);
      const app = createApp();

      const res = await app.request("/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
    });

    test("returns 401 and clears token when Copilot token exchange fails", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockRejectedValue(new Error("Token expired"));

      const app = createApp();
      const res = await app.request("/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
      expect(mockClearCopilotToken).toHaveBeenCalled();
    });

    test("proxies non-streaming response", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const anthropicResponse = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        model: "claude-sonnet-4",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 30,
          output_tokens: 10,
        },
      };

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(anthropicResponse), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "req_123" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "claude-sonnet-4",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hi" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = await res.json();

        // Verify real cache tokens are passed through
        expect(body.usage.input_tokens).toBe(100);
        expect(body.usage.cache_creation_input_tokens).toBe(50);
        expect(body.usage.cache_read_input_tokens).toBe(30);
        expect(body.usage.output_tokens).toBe(10);

        // Verify upstream URL
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.individual.githubcopilot.com/v1/messages");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("proxies SSE streaming response", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const sseData = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"cache_read_input_tokens":80}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("");

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(sseData, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "claude-sonnet-4",
            max_tokens: 1024,
            stream: true,
            messages: [{ role: "user", content: "Hi" }],
          }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        expect(res.headers.get("cache-control")).toBe("no-cache");

        // Read the stream
        const text = await res.text();
        expect(text).toContain("message_start");
        expect(text).toContain("cache_read_input_tokens");
        expect(text).toContain('"cache_read_input_tokens":80');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("forwards anthropic-specific headers", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "context-1m",
          },
        });

        const [, opts] = fetchMock.mock.calls[0];
        expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
        expect(opts.headers["anthropic-beta"]).toBe("context-1m");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("does not forward host/authorization/connection headers", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer user-token-should-be-replaced",
          },
        });

        const [, opts] = fetchMock.mock.calls[0];
        // Should use Copilot token, not the client's auth
        expect(opts.headers.Authorization).toBe("Bearer copilot_test_token");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns 502 and clears token on network error", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(502);
        expect(mockClearCopilotToken).toHaveBeenCalled();
        const body = await res.json();
        expect(body.error.message).toContain("ECONNREFUSED");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("clears token cache on 401 upstream response", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(401);
        expect(mockClearCopilotToken).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("clears token cache on 403 upstream response", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(403);
        expect(mockClearCopilotToken).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("injects required Copilot headers", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: { "Content-Type": "application/json" },
        });

        const [, opts] = fetchMock.mock.calls[0];
        expect(opts.headers["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
        expect(opts.headers["Editor-Version"]).toBe("vscode/1.107.0");
        expect(opts.headers["Editor-Plugin-Version"]).toBe("copilot-chat/0.35.0");
        expect(opts.headers["Copilot-Integration-Id"]).toBe("vscode-chat");
        expect(opts.headers["Openai-Intent"]).toBe("conversation-edits");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("strips content-length and transfer-encoding from upstream response", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ type: "message" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "999",
            "transfer-encoding": "chunked",
            "x-request-id": "req_pass_through",
          },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
          headers: { "Content-Type": "application/json" },
        });

        // These should be stripped
        expect(res.headers.get("transfer-encoding")).toBeNull();
        // x-request-id should pass through
        expect(res.headers.get("x-request-id")).toBe("req_pass_through");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("POST /v1/messages/count_tokens", () => {
    test("returns 401 when not logged in", async () => {
      mockGetStoredToken.mockReturnValue(null);
      const app = createApp();

      const res = await app.request("/v1/messages/count_tokens", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(401);
    });

    test("proxies count_tokens request", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockResolvedValue(makeCopilotToken());

      const countResponse = { input_tokens: 42 };
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(countResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const app = createApp();
        const res = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-4", messages: [{ role: "user", content: "Hi" }] }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.input_tokens).toBe(42);

        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.individual.githubcopilot.com/v1/messages/count_tokens");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns 502 on upstream failure", async () => {
      mockGetStoredToken.mockReturnValue("ghu_test");
      mockGetCopilotToken.mockRejectedValue(new Error("Network down"));

      const app = createApp();
      const res = await app.request("/v1/messages/count_tokens", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(502);
    });
  });

  describe("catch-all", () => {
    test("returns 404 for unknown GET route", async () => {
      const app = createApp();
      const res = await app.request("/v1/unknown");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.type).toBe("not_found_error");
      expect(body.error.message).toContain("GET");
      expect(body.error.message).toContain("/v1/unknown");
    });

    test("returns 404 for unknown POST route", async () => {
      const app = createApp();
      const res = await app.request("/something/else", { method: "POST" });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.message).toContain("POST");
    });
  });
});
