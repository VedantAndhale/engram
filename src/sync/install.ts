import { GitHub, GitHubError } from "./github";
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
export type ReachOutcome = { result: "added" | "not-installed" | "failed"; status?: number };

/** Same as reachRepo, but also says what GitHub answered, so the UI can show it. */
export async function reachRepoDetail(gh: InstallGh, repoId: number): Promise<ReachOutcome> {
  try {
    const { installations } = await gh.json<{ installations: Installation[] }>("/user/installations");
    const install = pickInstallation(installations ?? []);
    if (!install) return { result: "not-installed" };
    const res = await gh.request(`/user/installations/${install.id}/repositories/${repoId}`, { method: "PUT" });
    // 304 means the repo was already in the install, which is just as good.
    if (res.status === 204 || res.status === 304) return { result: "added", status: res.status };
    return { result: "failed", status: res.status };
  } catch (e) {
    // 403, 404 and 422 come back as thrown errors from the client; so does a dropped connection.
    return { result: "failed", status: e instanceof GitHubError ? e.status : undefined };
  }
}

/**
 * Makes sure the App can reach one repo. "not-installed" means the user hasn't installed the App
 * yet, so the caller should send them to INSTALL_URL instead of retrying.
 */
export async function reachRepo(gh: InstallGh, repoId: number): Promise<"added" | "not-installed" | "failed"> {
  return (await reachRepoDetail(gh, repoId)).result;
}

/**
 * Adds one folder's repo to the App's install. The repo id is saved with the folder, so no lookup
 * is needed. Older folders have no saved id, so the id is looked up first. That lookup only works
 * while the App can see the repo. Without the App installed, GitHub also answers 404, so the
 * install is checked before the lookup to say which of the two is the problem.
 */
export async function grantFolderRepo(token: string, repo: RepoRef): Promise<ReachOutcome> {
  const gh = new GitHub(token, repo);
  if (repo.id !== undefined) return reachRepoDetail(gh, repo.id);
  let id: number;
  try {
    const { installations } = await gh.json<{ installations: Installation[] }>("/user/installations");
    if (!pickInstallation(installations ?? [])) return { result: "not-installed" };
    id = (await gh.getRepo()).id;
  } catch (e) {
    return { result: "failed", status: e instanceof GitHubError ? e.status : undefined };
  }
  return reachRepoDetail(gh, id);
}
