import { create } from "zustand";
import type { Account } from "./github";
import { revokeSignIn } from "./signin";

const ACCOUNT_KEY = "reader.account";

/** The account as kept on this device. GitHub App sign-in adds a refresh token and when the token runs out. */
export type StoredAccount = Account & { refresh?: string; expiresAt?: number };

/** Where the last "Sign in with GitHub" got to, for the GitHub page to show. */
export type SignInStatus = { state: "busy" } | { state: "error"; message: string } | { state: "repoProblem"; login: string; message: string };

interface AccountStore {
  account: StoredAccount | null;
  /** GitHub stopped accepting the sign-in (revoked). Shown until the user signs in again. */
  authError: boolean;
  /** This device was connected with a personal access token, which Engram no longer takes. */
  legacyToken: boolean;
  signIn: SignInStatus | null;
}

/** gho_ comes from the OAuth App sign-in, ghu_ from the GitHub App sign-in. */
const isSignInToken = (token: string | undefined) => !!token && (token.startsWith("gho_") || token.startsWith("ghu_"));

/** Only tokens from Sign in with GitHub (gho_… or ghu_…) are kept; pasted personal access tokens are dropped. */
function load(): { account: StoredAccount | null; legacyToken: boolean } {
  let account: StoredAccount | null = null;
  try {
    account = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
  } catch {
    // unreadable: same as signed out
  }
  if (!account || isSignInToken(account.token)) return { account, legacyToken: false };
  // Changes waiting on this device stay queued and upload after the next sign-in.
  localStorage.removeItem(ACCOUNT_KEY);
  return { account: null, legacyToken: true };
}

export const useAccount = create<AccountStore>(() => ({ ...load(), authError: false, signIn: null }));

export const getAccount = () => useAccount.getState().account;

/** The account as it is stored right now, which another tab may have changed since this one loaded. */
export function storedAccount(): StoredAccount | null {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
  } catch {
    return null;
  }
}

// Each tab keeps its own copy of the sign-in. GitHub retires a refresh token when it is used, so a tab still holding
// an old one would fail the next refresh and lose the sign-in. Take the other tab's copy as it changes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    // A null key means the whole of this origin's storage was cleared, which also clears the sign-in.
    if (e.key !== ACCOUNT_KEY && e.key !== null) return;
    const next = storedAccount();
    useAccount.setState((s) => ({ account: next, authError: next?.token !== s.account?.token ? false : s.authError }));
  });
}

/** Saving null signs out (Disconnect): the token is revoked at GitHub as well as forgotten here. */
export function saveAccount(account: StoredAccount | null) {
  const before = getAccount()?.token;
  if (before && before !== account?.token) revokeSignIn(before);
  // refresh and expiresAt travel with the account object, so they are stored whenever it has them.
  if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  else localStorage.removeItem(ACCOUNT_KEY);
  useAccount.setState({ account, authError: false, legacyToken: false });
}

/**
 * After a refresh: swap in the new token, refresh token and expiry. No revoke of the old token, because GitHub
 * already retired it. `sent` is the refresh token the request used. If the account changed while the request ran
 * (signed out, or another account signed in), the new pair is not written onto it: it is revoked instead.
 * True when the new pair was stored.
 */
export function replaceTokens(token: string, refresh: string, expiresAt: number, sent: string): boolean {
  const current = storedAccount();
  if (!current || current.refresh !== sent) {
    revokeSignIn(token);
    return false;
  }
  const account: StoredAccount = { ...current, token, refresh, expiresAt };
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  useAccount.setState({ account, authError: false });
  return true;
}