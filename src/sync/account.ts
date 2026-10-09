import { create } from "zustand";
import type { Account } from "./github";

const ACCOUNT_KEY = "reader.account";

interface AccountStore {
  account: Account | null;
  /** The token stopped working (expired or revoked). Shown until the user pastes a new one. */
  authError: boolean;
}

function load(): Account | null {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null");
  } catch {
    return null;
  }
}

export const useAccount = create<AccountStore>(() => ({ account: load(), authError: false }));

export const getAccount = () => useAccount.getState().account;

export function saveAccount(account: Account | null) {
  if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  else localStorage.removeItem(ACCOUNT_KEY);
  useAccount.setState({ account, authError: false });
}
