// Writes the feeds script into the folder repo. A 404 on the write means the GitHub App can't reach
// that repo yet (folders made before the App was installed, or where adding them failed), so this
// adds the repo to the App's install and tries once more.
import { GitHubError } from "../sync/github";
import { INSTALL_URL, reachRepo, type InstallGh } from "../sync/install";

export interface ScriptGh extends InstallGh {
  getFile(path: string): Promise<{ sha: string } | null>;
  putFile(path: string, text: string, sha: string | undefined, message: string): Promise<string>;
  getRepo(): Promise<{ id: number }>;
}

export class RepoNotReachableError extends Error {
  constructor() {
    super(`Engram can't write to this folder's repo yet. Add it to the Engram Reader GitHub App here: ${INSTALL_URL}`);
  }
}

export async function putFeedScript(gh: ScriptGh, path: string, text: string): Promise<void> {
  const write = async () => {
    const existing = await gh.getFile(path);
    await gh.putFile(path, text, existing?.sha, "Install Engram feeds script");
  };
  try {
    await write();
    return;
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
  }
  const repo = await gh.getRepo();
  if ((await reachRepo(gh, repo.id)) !== "added") throw new RepoNotReachableError();
  await write();
}
