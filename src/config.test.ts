import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, getConfigDir } from "./config.js";

describe("config", () => {
  let originalEnv: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = process.env.COPA_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "copa-test-"));
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

  describe("getConfigDir", () => {
    test("returns COPA_CONFIG_DIR when set", () => {
      expect(getConfigDir()).toBe(tempDir);
    });

    test("creates directory if it does not exist", () => {
      const nested = join(tempDir, "sub", "dir");
      process.env.COPA_CONFIG_DIR = nested;
      expect(getConfigDir()).toBe(nested);
      // Should not throw on second call
      expect(getConfigDir()).toBe(nested);
    });
  });

  describe("loadConfig", () => {
    test("returns empty object when config file does not exist", () => {
      const config = loadConfig();
      expect(config).toEqual({});
    });

    test("returns parsed config when file exists", () => {
      const configPath = join(tempDir, "config.json");
      writeFileSync(configPath, JSON.stringify({ github_token: "ghu_test123" }));

      const config = loadConfig();
      expect(config).toEqual({ github_token: "ghu_test123" });
    });

    test("returns empty object when config file has invalid JSON", () => {
      const configPath = join(tempDir, "config.json");
      writeFileSync(configPath, "not-json{{{");

      const config = loadConfig();
      expect(config).toEqual({});
    });
  });

  describe("saveConfig", () => {
    test("writes config to disk", () => {
      saveConfig({ github_token: "ghu_abc" });

      const configPath = join(tempDir, "config.json");
      const raw = readFileSync(configPath, "utf-8");
      expect(JSON.parse(raw)).toEqual({ github_token: "ghu_abc" });
    });

    test("overwrites existing config", () => {
      saveConfig({ github_token: "old" });
      saveConfig({ github_token: "new" });

      const configPath = join(tempDir, "config.json");
      const raw = readFileSync(configPath, "utf-8");
      expect(JSON.parse(raw)).toEqual({ github_token: "new" });
    });

    test("writes pretty-printed JSON with trailing newline", () => {
      saveConfig({ github_token: "ghu_fmt" });

      const configPath = join(tempDir, "config.json");
      const raw = readFileSync(configPath, "utf-8");
      expect(raw).toBe(JSON.stringify({ github_token: "ghu_fmt" }, null, 2) + "\n");
    });

    test("saves empty config (delete token)", () => {
      saveConfig({ github_token: "ghu_abc" });
      saveConfig({});

      const config = loadConfig();
      expect(config).toEqual({});
      expect(config.github_token).toBeUndefined();
    });
  });

  describe("round-trip", () => {
    test("save then load preserves data", () => {
      const original = { github_token: "ghu_roundtrip" };
      saveConfig(original);
      const loaded = loadConfig();
      expect(loaded).toEqual(original);
    });
  });
});
