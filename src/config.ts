/**
 * Persistent config storage for Copa.
 * Stored at ~/.config/copa/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CopaConfig {
  github_token?: string;
}

function getConfigDir(): string {
  const dir = join(homedir(), ".config", "copa");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function loadConfig(): CopaConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CopaConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CopaConfig): void {
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
