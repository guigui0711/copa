/**
 * Copa logger — writes to both console and ~/.config/copa/logs/.
 *
 * Log files are rotated daily: copa-2026-04-17.log
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";

let logDir: string | null = null;

function getLogDir(): string {
  if (!logDir) {
    logDir = join(getConfigDir(), "logs");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }
  return logDir;
}

function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(getLogDir(), `copa-${date}.log`);
}

function timestamp(): string {
  return new Date().toISOString();
}

function writeToFile(level: string, msg: string): void {
  try {
    appendFileSync(getLogFile(), `${timestamp()} [${level}] ${msg}\n`);
  } catch {
    // Silently ignore file write errors — don't break the proxy
  }
}

export const log = {
  info(msg: string): void {
    console.log(`[copa] ${msg}`);
    writeToFile("INFO", msg);
  },
  warn(msg: string): void {
    console.warn(`[copa] ${msg}`);
    writeToFile("WARN", msg);
  },
  error(msg: string): void {
    console.error(`[copa] ${msg}`);
    writeToFile("ERROR", msg);
  },
  /** Log request summary (method, path, status, duration) */
  request(method: string, path: string, status: number, durationMs: number, extra?: string): void {
    const msg = `${method} ${path} → ${status} (${durationMs}ms)${extra ? " " + extra : ""}`;
    console.log(`[copa] ${msg}`);
    writeToFile("REQ", msg);
  },
};
