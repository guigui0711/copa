/**
 * GitHub OAuth Device Flow for Copilot authentication.
 *
 * Flow:
 * 1. POST /login/device/code → get device_code + user_code + verification_uri
 * 2. User opens browser, enters user_code
 * 3. Poll POST /login/oauth/access_token until user authorizes
 * 4. Store the OAuth token for Copilot token exchange
 */

import { loadConfig, saveConfig } from "./config.js";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"; // VS Code's OAuth app
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

/** Start the device flow and return the user code + verification URL. */
async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!res.ok) {
    throw new Error(`Device code request failed: ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<DeviceCodeResponse>;
}

/** Poll for the access token after user authorizes the device. */
async function pollForAccessToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    await sleep(pollInterval * 1000);

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!res.ok) {
      throw new Error(`Token poll failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as AccessTokenResponse;

    if (data.access_token) {
      return data.access_token;
    }

    switch (data.error) {
      case "authorization_pending":
        // User hasn't authorized yet, keep polling
        break;
      case "slow_down":
        // Increase interval by 5 seconds
        pollInterval = (data.interval ?? pollInterval) + 5;
        break;
      case "expired_token":
        throw new Error("Device code expired. Please run login again.");
      case "access_denied":
        throw new Error("Authorization denied by user.");
      default:
        throw new Error(`OAuth error: ${data.error} — ${data.error_description}`);
    }
  }

  throw new Error("Device code expired (timeout). Please run login again.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the full GitHub OAuth Device Flow.
 * Returns the OAuth access token (ghu_...).
 */
export async function login(): Promise<string> {
  const deviceCode = await requestDeviceCode();

  console.log();
  console.log("  Please open this URL in your browser:");
  console.log(`  \x1b[1;36m${deviceCode.verification_uri}\x1b[0m`);
  console.log();
  console.log("  And enter this code:");
  console.log(`  \x1b[1;33m${deviceCode.user_code}\x1b[0m`);
  console.log();
  console.log("  Waiting for authorization...");

  const token = await pollForAccessToken(
    deviceCode.device_code,
    deviceCode.interval,
    deviceCode.expires_in,
  );

  // Persist the token
  const config = loadConfig();
  config.github_token = token;
  saveConfig(config);

  console.log("  \x1b[1;32mLogin successful!\x1b[0m");
  console.log();

  return token;
}

/**
 * Get the stored GitHub OAuth token, or null if not logged in.
 */
export function getStoredToken(): string | null {
  const config = loadConfig();
  return config.github_token ?? null;
}
