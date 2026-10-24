import { useAccount, getAccount, replaceTokens, storedAccount } from "./account";

// GitHub App sign-in tokens last 8 hours, so renew one comfortably before it runs out.
const REFRESH_WINDOW_MS = 60 * 60_000;
// How long a tab waits for another tab's refresh before giving up for now.
const LOCK_WAIT_MS = 25_000;

// GitHub retires the old refresh token the moment it is used. Two refreshes at once would make the
// second one fail and lose the sign-in, so everyone who asks while one is running shares it.
let inFlight: Promise<boolean> | null = null;

/** Trades the stored refresh token for a new sign-in token. True when the account now has a fresh one. */
export async function refreshSignIn(): Promise<boolean> {
  if (!inFlight) {
    inFlight = withTabLock(run).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** One refresh at a time across every open tab of the app, so the refresh token is only ever used once. */
function withTabLock(task: () => Promise<boolean>): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks) return task();
  // The wait is bounded: a tab that cannot get the lock in time simply tries again on a later tick.
  return navigator.locks.request("engram-sign-in", { signal: afterMs(LOCK_WAIT_MS) }, task).catch(() => false);
}

function afterMs(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function run(): Promise<boolean> {
  // The stored account is the truth: a sign-out in another tab leaves nothing to refresh.
  const stored = storedAccount();
  if (!stored) return false;
  // Another tab may have refreshed while this one waited for the lock. Its new token is already stored, so use it.
  if (stored.expiresAt && stored.expiresAt - Date.now() >= REFRESH_WINDOW_MS && stored.token !== getAccount()?.token) {
    useAccount.setState({ account: stored, authError: false });
    return true;
  }
  if (!stored.refresh) return false;
  const sent = stored.refresh;

  // No timeout here on purpose: GitHub may already have retired the refresh token, and an abort would throw away the
  // new one. The lock wait above is the bound that matters.
  let res: Response;
  try {
    res = await fetch(new URL("/api/oauth/refresh", location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: sent }),
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
        return replaceTokens(body.token, body.refresh, Date.now() + body.expires_in * 1000, sent);
      }
    } catch {
      // not JSON: handled below like any other bad answer
    }
  }

  // The account may have changed while the request ran (signed out, or signed in as someone else). Then this refusal
  // is about an account the user is no longer using, so it does not mark the current sign-in as broken.
  if (storedAccount()?.refresh !== sent) return false;
  // 401 (GitHub refused the refresh token) or an answer we can't use: the user has to sign in again.
  useAccount.setState({ authError: true });
  return false;
}

/** Refreshes only when the token is within an hour of expiring (or already expired). Not after a refusal. */
export function refreshIfDue(now = Date.now()): Promise<boolean> {
  if (useAccount.getState().authError) return Promise.resolve(false);
  const expiresAt = getAccount()?.expiresAt;
  if (!expiresAt || expiresAt - now >= REFRESH_WINDOW_MS) return Promise.resolve(false);
  return refreshSignIn();
}
