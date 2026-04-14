/**
 * Copilot API Token management.
 *
 * Exchanges a long-lived GitHub OAuth token for a short-lived Copilot API token.
 * Handles automatic refresh before expiry.
 */

export interface CopilotToken {
  /** The short-lived Bearer token for Copilot API calls */
  token: string;
  /** Unix timestamp (seconds) when the token expires */
  expiresAt: number;
  /** Copilot API base URL derived from the token */
  apiBase: string;
}

interface TokenEnvelope {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints?: {
    api?: string;
  };
}

const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";

/** Buffer before expiry to trigger refresh (2 minutes) */
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

let cachedToken: CopilotToken | null = null;

/**
 * Exchange a GitHub OAuth token for a Copilot API token.
 */
async function exchangeToken(githubToken: string): Promise<CopilotToken> {
  const res = await fetch(TOKEN_EXCHANGE_URL, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
      "User-Agent": "Copa/0.1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      throw new Error(
        "GitHub token is invalid or expired. Run `copa login` to re-authenticate.",
      );
    }
    throw new Error(`Copilot token exchange failed: ${res.status} ${body}`);
  }

  const envelope = (await res.json()) as TokenEnvelope;

  // Derive API base from token's proxy-ep field or endpoints object
  let apiBase = envelope.endpoints?.api ?? "https://api.githubcopilot.com";

  // Some tokens have proxy-ep in the token string itself
  if (apiBase === "https://api.githubcopilot.com") {
    const proxyMatch = envelope.token.match(/proxy-ep=([^;:]+)/);
    if (proxyMatch) {
      apiBase = `https://${proxyMatch[1].replace("proxy.", "api.")}`;
    }
  }

  return {
    token: envelope.token,
    expiresAt: envelope.expires_at,
    apiBase,
  };
}

/**
 * Get a valid Copilot API token.
 * Caches the token and auto-refreshes before expiry.
 */
export async function getCopilotToken(githubToken: string): Promise<CopilotToken> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt * 1000 - now > REFRESH_BUFFER_MS) {
    return cachedToken;
  }

  cachedToken = await exchangeToken(githubToken);
  return cachedToken;
}

/**
 * Clear the cached token (e.g., on auth error).
 */
export function clearCopilotToken(): void {
  cachedToken = null;
}
