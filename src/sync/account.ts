import { create } from "zustand";
import type { Account } from "./github";

const ACCOUNT_KEY = "reader.account";

/** Where the last "Sign in with GitHub" got to, for the GitHub page to show. */
export type SignInStatus = { state: "busy" } | { state: "error"; message: string } | { state: "repoProblem"; login: string; message: string };

interface AccountStore {
  account: Account | null;
  /** GitHub stopped accepting the sign-in (revoked). Shown until the user signs in again. */
  authError: boolean;
  /** This device was connected with a personal access token, which Engram no longer takes. */
  legacyToken: boolean;
  signIn: SignInStatus | null;
}

/** Only tokens from Sign in with GitHub (gho_…) are kept; pasted personal access tokens are dropped. */
function load(): { account: Account | null; legacyToken: boolean } {
  let account: Account | null = null;
  try {
    account = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
  } catch {
    // unreadable: same as signed out
  }
  if (!account || account.token?.startsWith("gho_")) return { account, legacyToken: false };
  // Changes waiting on this device stay queued and upload after the next sign-in.
  localStorage.removeItem(ACCOUNT_KEY);
  return { account: null, legacyToken: true };
}

export const useAccount = create<AccountStore>(() => ({ ...load(), authError: false, signIn: null }));

export const getAccount = () => useAccount.getState().account;

export function saveAccount(account: Account | null) {
  if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  else localStorage.removeItem(ACCOUNT_KEY);
  useAccount.setState({ account, authError: false, legacyToken: false });
}
