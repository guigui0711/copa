#!/usr/bin/env bun
/**
 * Copa CLI — Copilot-to-Anthropic proxy.
 *
 * Usage:
 *   copa login    — Authenticate with GitHub (Device Flow)
 *   copa start    — Start the proxy server
 *   copa status   — Check login & server status
 *   copa logout   — Remove stored credentials
 */

import { login, getStoredToken } from "./auth.js";
import { getCopilotToken } from "./copilot-token.js";
import { createApp, DEFAULT_PORT } from "./server.js";
import { loadConfig, saveConfig } from "./config.js";

const VERSION = "0.1.0";

const HELP = `
\x1b[1mcopa\x1b[0m v${VERSION} — Copilot-to-Anthropic proxy

\x1b[1mUsage:\x1b[0m
  copa login     Authenticate with GitHub (Device Flow)
  copa start     Start the proxy server
  copa status    Check login & server status
  copa logout    Remove stored credentials
  copa help      Show this help

\x1b[1mClaude Code setup:\x1b[0m
  Add to ~/.claude/settings.json:
  {
    "env": {
      "ANTHROPIC_BASE_URL": "http://localhost:${DEFAULT_PORT}",
      "ANTHROPIC_AUTH_TOKEN": "copa"
    }
  }
`;

async function cmdLogin() {
  console.log("\x1b[1m[copa]\x1b[0m Starting GitHub authentication...");
  await login();
}

async function cmdStart() {
  const port = parseInt(process.env.COPA_PORT ?? String(DEFAULT_PORT), 10);

  // Check auth
  const githubToken = getStoredToken();
  if (!githubToken) {
    console.error("\x1b[1;31m[copa]\x1b[0m Not logged in. Run `copa login` first.");
    process.exit(1);
  }

  // Verify the token works by exchanging it
  console.log("\x1b[1m[copa]\x1b[0m Verifying GitHub credentials...");
  try {
    const copilot = await getCopilotToken(githubToken);
    console.log(`\x1b[1m[copa]\x1b[0m Copilot API: ${copilot.apiBase}`);
    console.log(
      `\x1b[1m[copa]\x1b[0m Token expires: ${new Date(copilot.expiresAt * 1000).toLocaleTimeString()} (auto-refreshes)`,
    );
  } catch (err) {
    console.error(`\x1b[1;31m[copa]\x1b[0m Token verification failed: ${err}`);
    console.error("  Run `copa login` to re-authenticate.");
    process.exit(1);
  }

  // Start server
  const app = createApp();

  console.log();
  console.log(`\x1b[1;32m[copa]\x1b[0m Proxy running on \x1b[1;36mhttp://localhost:${port}\x1b[0m`);
  console.log();
  console.log("  Claude Code config (~/.claude/settings.json):");
  console.log(`  {`);
  console.log(`    "env": {`);
  console.log(`      "ANTHROPIC_BASE_URL": "http://localhost:${port}",`);
  console.log(`      "ANTHROPIC_AUTH_TOKEN": "copa"`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();
  console.log("  Press Ctrl+C to stop.");
  console.log();

  Bun.serve({
    port,
    fetch: app.fetch,
  });
}

async function cmdStatus() {
  const githubToken = getStoredToken();

  console.log(`\x1b[1m[copa]\x1b[0m v${VERSION}`);
  console.log();

  if (!githubToken) {
    console.log("  Auth:   \x1b[1;31mNot logged in\x1b[0m");
    console.log("          Run `copa login` to authenticate.");
  } else {
    console.log("  Auth:   \x1b[1;32mLogged in\x1b[0m (GitHub OAuth token stored)");

    try {
      const copilot = await getCopilotToken(githubToken);
      const expiresIn = Math.round((copilot.expiresAt * 1000 - Date.now()) / 60000);
      console.log(`  Copilot: \x1b[1;32mValid\x1b[0m (expires in ${expiresIn} min)`);
      console.log(`  API:     ${copilot.apiBase}`);
    } catch (err) {
      console.log(`  Copilot: \x1b[1;31mFailed\x1b[0m — ${err}`);
    }
  }

  // Check if server is running
  const port = parseInt(process.env.COPA_PORT ?? String(DEFAULT_PORT), 10);
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      console.log(`  Server:  \x1b[1;32mRunning\x1b[0m on port ${port}`);
    } else {
      console.log(`  Server:  \x1b[1;33mPort ${port} in use (not copa?)\x1b[0m`);
    }
  } catch {
    console.log(`  Server:  \x1b[1;31mNot running\x1b[0m`);
  }

  console.log();
}

function cmdLogout() {
  const config = loadConfig();
  delete config.github_token;
  saveConfig(config);
  console.log("\x1b[1m[copa]\x1b[0m Logged out. Stored credentials removed.");
}

// --- Main ---

const command = process.argv[2];

switch (command) {
  case "login":
    await cmdLogin();
    break;
  case "start":
    await cmdStart();
    break;
  case "status":
    await cmdStatus();
    break;
  case "logout":
    cmdLogout();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(HELP);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(`copa v${VERSION}`);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
