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
 * After a refresh: swap in the new token, refresh token and expiry. No revoke, because GitHub
 * already retired the old token. Does nothing if the user signed out while the refresh ran.
 */
export function replaceTokens(token: string, refresh: string, expiresAt: number) {
  const current = getAccount();
  if (!current) return;
  const account: StoredAccount = { ...current, token, refresh, expiresAt };
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  useAccount.setState({ account, authError: false });
}