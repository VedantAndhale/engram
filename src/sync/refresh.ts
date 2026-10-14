import { useAccount, getAccount, replaceTokens } from "./account";

// GitHub App sign-in tokens last 8 hours, so renew one comfortably before it runs out.
const REFRESH_WINDOW_MS = 60 * 60_000;

// GitHub retires the old refresh token the moment it is used. Two refreshes at once would make the
// second one fail and lose the sign-in, so everyone who asks while one is running shares it.
let inFlight: Promise<boolean> | null = null;

/** Trades the stored refresh token for a new sign-in token. True when the account now has a fresh one. */
export async function refreshSignIn(): Promise<boolean> {
  if (!inFlight) {
    inFlight = run().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function run(): Promise<boolean> {
  const account = getAccount();
  if (!account || !account.refresh) return false;

  let res: Response;
  try {
    res = await fetch(new URL("/api/oauth/refresh", location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: account.refresh }),
      credentials: "omit",
      keepalive: false,
    });
  } catch {
    // Offline or blocked. The sign-in itself may be fine, so don't tell the user it broke.
    return false;
  }

  // A server hiccup or rate limit says nothing about whether the sign-in is still good.
  if (res.status >= 500 || res.status === 429) return false;

  if (res.ok) {
    try {
      const body = (await res.json()) as { token?: unknown; refresh?: unknown; expires_in?: unknown };
      if (typeof body.token === "string" && typeof body.refresh === "string" && typeof body.expires_in === "number" && body.expires_in > 0) {
        // Store the new refresh token at once: the old one no longer works.
        replaceTokens(body.token, body.refresh, Date.now() + body.expires_in * 1000);
        return true;
      }
    } catch {
      // not JSON: handled below like any other bad answer
    }
  }

  // 401 (GitHub refused the refresh token) or an answer we can't use: the user has to sign in again.
  useAccount.setState({ authError: true });
  return false;
}

/** Refreshes only when the token is within an hour of expiring (or already expired). */
export function refreshIfDue(now = Date.now()): Promise<boolean> {
  const expiresAt = getAccount()?.expiresAt;
  if (!expiresAt || expiresAt - now >= REFRESH_WINDOW_MS) return Promise.resolve(false);
  return refreshSignIn();
}