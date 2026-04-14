import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStoredToken, login } from "./auth.js";
import { saveConfig, loadConfig } from "./config.js";

let tempDir: string;
let originalEnv: string | undefined;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalEnv = process.env.COPA_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "copa-auth-test-"));
  process.env.COPA_CONFIG_DIR = tempDir;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) {
    delete process.env.COPA_CONFIG_DIR;
  } else {
    process.env.COPA_CONFIG_DIR = originalEnv;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function deviceCodeResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      device_code: "dc_test",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 0,
      ...overrides,
    }),
    { status: 200 },
  );
}

describe("auth", () => {
  describe("getStoredToken", () => {
    test("returns null when no config exists", () => {
      expect(getStoredToken()).toBeNull();
    });

    test("returns null when config has no github_token", () => {
      saveConfig({});
      expect(getStoredToken()).toBeNull();
    });

    test("returns the stored token when present", () => {
      saveConfig({ github_token: "ghu_stored123" });
      expect(getStoredToken()).toBe("ghu_stored123");
    });
  });

  describe("login", () => {
    test("completes device flow and persists token", async () => {
      const fetchMock = vi.fn()
        // POST /login/device/code
        .mockResolvedValueOnce(deviceCodeResponse())
        // POST /login/oauth/access_token — pending
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 }),
        )
        // POST /login/oauth/access_token — success
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: "ghu_logintest", token_type: "bearer", scope: "read:user" }),
            { status: 200 },
          ),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      const token = await login();

      expect(token).toBe("ghu_logintest");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0][0]).toBe("https://github.com/login/device/code");
      expect(fetchMock.mock.calls[1][0]).toBe("https://github.com/login/oauth/access_token");

      // Verify token was persisted
      const config = loadConfig();
      expect(config.github_token).toBe("ghu_logintest");
    });

    test("throws on device code request failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 }),
      );
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(login()).rejects.toThrow("Device code request failed: 400");
    });

    test("handles slow_down by increasing interval then succeeds", async () => {
      // The slow_down handler sets pollInterval = (data.interval ?? pollInterval) + 5
      // With interval=0 in slow_down response, new interval = 0 + 5 = 5 seconds.
      // To avoid real 5s wait, we mock setTimeout via vi.useFakeTimers.
      vi.useFakeTimers();

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        // First poll: slow_down
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "slow_down", interval: 0 }), { status: 200 }),
        )
        // Second poll: success
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "ghu_after_slowdown" }), { status: 200 }),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      const loginPromise = login();

      // First sleep(0) — initial poll with interval=0
      await vi.advanceTimersByTimeAsync(0);
      // Second sleep(5000) — after slow_down, interval becomes 5s
      await vi.advanceTimersByTimeAsync(5000);

      const token = await loginPromise;
      expect(token).toBe("ghu_after_slowdown");
      expect(fetchMock).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    test("throws on access_denied", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "access_denied" }), { status: 200 }),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(login()).rejects.toThrow("Authorization denied by user");
    });

    test("throws on expired_token", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "expired_token" }), { status: 200 }),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(login()).rejects.toThrow("Device code expired");
    });

    test("throws on poll HTTP failure", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(login()).rejects.toThrow("Token poll failed: 500");
    });

    test("throws on unknown OAuth error", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: "server_error", error_description: "Something broke" }),
            { status: 200 },
          ),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(login()).rejects.toThrow("OAuth error: server_error — Something broke");
    });

    test("sends correct client_id and scope in device code request", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "ghu_verify" }), { status: 200 }),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await login();

      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.client_id).toBe("Iv1.b507a08c87ecfe98");
      expect(body.scope).toBe("read:user");
    });

    test("sends correct grant_type in token poll request", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deviceCodeResponse())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "ghu_grant" }), { status: 200 }),
        );

      globalThis.fetch = fetchMock;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await login();

      const [, opts] = fetchMock.mock.calls[1];
      const body = JSON.parse(opts.body as string);
      expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(body.device_code).toBe("dc_test");
    });
  });
});
