import { GitHub } from "./github";
import type { RepoRef } from "../model";

// Where people install the Engram Reader GitHub App, and how a new folder repo gets added to that
// install. The App only reaches the repos the user picked, so each new folder repo must be added.

export const APP_SLUG = "engram-reader";
export const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

export interface Installation {
  id: number;
  app_slug: string;
  repository_selection: string;
}

/** The user's install of Engram Reader. They may have other GitHub Apps installed too. */
export function pickInstallation(list: Installation[]): Installation | null {
  return list.find((i) => i.app_slug === APP_SLUG) ?? null;
}

/** The slice of the GitHub client this needs, so tests can pass a stand-in. */
export interface InstallGh {
  request(path: string, opts?: { method?: string; body?: unknown }): Promise<Response>;
  json<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T>;
}

/**
 * Makes sure the App can reach one repo. "not-installed" means the user hasn't installed the App
 * yet, so the caller should send them to INSTALL_URL instead of retrying.
 */
export async function reachRepo(gh: InstallGh, repoId: number): Promise<"added" | "not-installed" | "failed"> {
  try {
    const { installations } = await gh.json<{ installations: Installation[] }>("/user/installations");
    const install = pickInstallation(installations ?? []);
    if (!install) return "not-installed";
    const res = await gh.request(`/user/installations/${install.id}/repositories/${repoId}`, { method: "PUT" });
    // 304 means the repo was already in the install, which is just as good.
    return res.status === 204 || res.status === 304 ? "added" : "failed";
  } catch {
    // 403, 404 and 422 come back as thrown errors from the client; so does a dropped connection.
    return "failed";
  }
}
/** Adds one folder's repo to the App's install, by looking up its id on GitHub. */
export async function grantFolderRepo(token: string, repo: RepoRef): Promise<"added" | "not-installed" | "failed"> {
  const gh = new GitHub(token, repo);
  return reachRepo(gh, (await gh.getRepo()).id);
}
