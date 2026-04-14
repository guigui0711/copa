import { describe, test, expect, vi, beforeEach } from "vitest";
import { getCopilotToken, clearCopilotToken } from "./copilot-token.js";

function makeTokenEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    token: "tid=abc;exp=999;sku=copilot;proxy-ep=proxy.individual.githubcopilot.com:hmac",
    expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 min from now
    refresh_in: 1500,
    endpoints: {
      api: "https://api.individual.githubcopilot.com",
    },
    ...overrides,
  };
}

describe("copilot-token", () => {
  beforeEach(() => {
    clearCopilotToken();
    vi.restoreAllMocks();
  });

  describe("getCopilotToken", () => {
    test("exchanges GitHub token for Copilot token", async () => {
      const envelope = makeTokenEnvelope();
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(envelope), { status: 200 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const result = await getCopilotToken("ghu_test");

        expect(result.token).toBe(envelope.token);
        expect(result.expiresAt).toBe(envelope.expires_at);
        expect(result.apiBase).toBe("https://api.individual.githubcopilot.com");

        // Verify correct request
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.github.com/copilot_internal/v2/token");
        expect(opts.headers.Authorization).toBe("token ghu_test");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns cached token when not expired", async () => {
      const envelope = makeTokenEnvelope();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(envelope), { status: 200 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const first = await getCopilotToken("ghu_cache");
        const second = await getCopilotToken("ghu_cache");

        expect(first).toBe(second); // Same object reference
        expect(fetchMock).toHaveBeenCalledOnce(); // Only one fetch
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("refreshes token when close to expiry", async () => {
      // First token: expires in 1 minute (< 2 min buffer)
      const nearExpiry = makeTokenEnvelope({
        token: "old-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
      const fresh = makeTokenEnvelope({
        token: "new-token",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      });

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(nearExpiry), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(fresh), { status: 200 }));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const first = await getCopilotToken("ghu_refresh");
        expect(first.token).toBe("old-token");

        const second = await getCopilotToken("ghu_refresh");
        expect(second.token).toBe("new-token");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("throws on 401 with clear message", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        await expect(getCopilotToken("ghu_bad")).rejects.toThrow(
          "GitHub token is invalid or expired. Run `copa login` to re-authenticate.",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("throws on other HTTP errors", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response("Service Unavailable", { status: 503 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        await expect(getCopilotToken("ghu_503")).rejects.toThrow(
          "Copilot token exchange failed: 503 Service Unavailable",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("derives apiBase from endpoints.api", async () => {
      const envelope = makeTokenEnvelope({
        endpoints: { api: "https://api.business.githubcopilot.com" },
        token: "tid=x;sku=biz:hmac", // No proxy-ep
      });
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(envelope), { status: 200 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const result = await getCopilotToken("ghu_biz");
        expect(result.apiBase).toBe("https://api.business.githubcopilot.com");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("derives apiBase from proxy-ep in token when endpoints missing", async () => {
      const envelope = makeTokenEnvelope({
        endpoints: undefined,
        token: "tid=x;proxy-ep=proxy.enterprise.githubcopilot.com;sku=ent:hmac",
      });
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(envelope), { status: 200 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const result = await getCopilotToken("ghu_ent");
        expect(result.apiBase).toBe("https://api.enterprise.githubcopilot.com");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("falls back to default apiBase when no proxy-ep and no endpoints", async () => {
      const envelope = makeTokenEnvelope({
        endpoints: undefined,
        token: "tid=x;sku=free:hmac", // No proxy-ep
      });
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(envelope), { status: 200 }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        const result = await getCopilotToken("ghu_free");
        expect(result.apiBase).toBe("https://api.githubcopilot.com");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("clearCopilotToken", () => {
    test("clears cached token so next call fetches fresh", async () => {
      const envelope = makeTokenEnvelope();
      // Each call must return a NEW Response (body can only be read once)
      const fetchMock = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(envelope), { status: 200 })),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;

      try {
        await getCopilotToken("ghu_clear");
        expect(fetchMock).toHaveBeenCalledOnce();

        clearCopilotToken();

        await getCopilotToken("ghu_clear");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
