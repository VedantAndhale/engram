// Sign-in configuration that needs no network and no Node globals.
// Keeping it pure lets the web app's test runner import it directly.

export type SignInMode = "app" | "oauth";

type Env = Record<string, string | undefined>;

// GitHub refresh tokens last 6 months.
export const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// OAuth App tokens do not expire on their own, so we cap them at 30 days.
export const OAUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// App mode needs the opt-in flag and both App values, so a half-set environment stays on OAuth.
export function signInMode(env: Env): SignInMode {
  const on = env.SIGNIN_APP === "1";
  const hasApp = !!env.GITHUB_APP_CLIENT_ID && !!env.GITHUB_APP_CLIENT_SECRET;
  return on && hasApp ? "app" : "oauth";
}

// The client pair for the chosen mode, or null when either half is missing.
export function clientFor(
  env: Env,
  mode: SignInMode,
): { id: string; secret: string } | null {
  const id = mode === "app" ? env.GITHUB_APP_CLIENT_ID : env.GITHUB_CLIENT_ID;
  const secret =
    mode === "app" ? env.GITHUB_APP_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

// App tokens die when GitHub says so (8 hours); OAuth tokens get our 30-day cap.
export function accessTtlMs(mode: SignInMode, expiresInSeconds?: number): number {
  if (
    mode === "app" &&
    typeof expiresInSeconds === "number" &&
    Number.isFinite(expiresInSeconds) &&
    expiresInSeconds > 0
  ) {
    return expiresInSeconds * 1000;
  }
  return OAUTH_TOKEN_TTL_MS;
}

// Only GitHub App user tokens come with a refresh token.
export function refreshable(mode: SignInMode): boolean {
  return mode === "app";
}