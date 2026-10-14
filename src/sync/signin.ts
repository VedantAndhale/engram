/*
 * Sign in with GitHub. The app leaves for /api/oauth/login and GitHub sends it back with the
 * token in the address fragment (#engram-auth&token=…&nonce=…), which browsers never send to a
 * server. This module reads it before the router looks at the address, and clears it at once.
 *
 * The nonce proves this browser started the sign-in, so nobody can slip their own account in
 * with a link. It lives in localStorage, not sessionStorage: an installed app on Android may
 * come back in a browser tab, which shares localStorage but not sessionStorage.
 */

const NONCE_KEY = "engram.signin";
const MARK = "#engram-auth";
const NONCE_TTL_MS = 15 * 60_000;

/** refresh and expiresAt only come back from GitHub App sign-in, where tokens last 8 hours. */
export type SignInReturn = { token: string; refresh?: string; expiresAt?: number } | { error: string };

/** Reads what the server put in the fragment. Pure, so it can be tested without a browser. */
export function signInFromParams(p: URLSearchParams, now = Date.now()): SignInReturn {
  const token = p.get("token");
  if (!token) return { error: p.get("error") || "GitHub sign-in failed." };
  const out: { token: string; refresh?: string; expiresAt?: number } = { token };
  const refresh = p.get("refresh");
  if (refresh) out.refresh = refresh;
  // "expires" is seconds from now; anything that isn't a positive number is ignored.
  const expires = Number(p.get("expires"));
  if (Number.isFinite(expires) && expires > 0) out.expiresAt = now + expires * 1000;
  return out;
}

let returned: SignInReturn | null = take();

function take(): SignInReturn | null {
  // No address bar outside a browser (unit tests), so there is nothing to read.
  if (typeof location === "undefined" || !location.hash.startsWith(MARK)) return null;
  const p = new URLSearchParams(location.hash.slice(MARK.length));
  history.replaceState(null, "", `${location.pathname}${location.search}#/setup`);
  let expected: { nonce: string; at: number } | null = null;
  try {
    expected = JSON.parse(localStorage.getItem(NONCE_KEY) ?? "null");
  } catch {
    // treated as not started here
  }
  localStorage.removeItem(NONCE_KEY);
  if (!expected || Date.now() - expected.at > NONCE_TTL_MS || p.get("nonce") !== expected.nonce) {
    return { error: "That sign-in wasn't started on this device, or took too long. Try again." };
  }
  return signInFromParams(p);
}

/** What came back from GitHub on this page load, once. */
export function takeSignIn(): SignInReturn | null {
  const r = returned;
  returned = null;
  return r;
}

/**
 * Ends a sign-in at GitHub, so the token stops working even if a copy of it survives somewhere.
 * Only this token: other devices and connected agents stay signed in. Best effort: offline, or
 * on a copy with no server, the token is only forgotten here.
 */
export function revokeSignIn(token: string) {
  void fetch(new URL("/api/oauth/revoke", location.origin), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "access_token" }),
    keepalive: true,
  }).catch(() => {});
}

/** Off to GitHub. Engram's server is on this same site (see mcp/oauth.ts). */
export function startSignIn() {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  localStorage.setItem(NONCE_KEY, JSON.stringify({ nonce, at: Date.now() }));
  const url = new URL("/api/oauth/login", location.origin);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("return", location.origin + location.pathname);
  location.assign(url);
}