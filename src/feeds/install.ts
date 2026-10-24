// What the app puts into the user's folder repo to turn feeds on, and how it checks
// that the setup is still in place. The files are bundled as text at build time.
import type { GitHub } from "../sync/github";
import fetchScript from "./action/fetch-feeds.mjs?raw";
import workflowYaml from "./action/engram-feeds.yml?raw";
import { installedVersion, installStatus, type InstallStatus } from "./installstatus";

// Bump this together with the "engram-feeds vN" first line of both files below.
export const FEEDS_VERSION = 2;

export type FeedInstallFile = { path: string; text: string };

export const FEED_INSTALL_FILES: FeedInstallFile[] = [
  { path: "feeds/action/fetch-feeds.mjs", text: fetchScript },
  { path: ".github/workflows/engram-feeds.yml", text: workflowYaml },
];

// Reads both files from the repo and reports whether the install is missing,
// half done, old, or up to date.
export async function checkInstall(gh: GitHub): Promise<InstallStatus> {
  const found = await Promise.all(
    FEED_INSTALL_FILES.map(async (f) => {
      const file = await gh.getFile(f.path);
      return { path: f.path, version: installedVersion(file ? file.text : null) };
    }),
  );
  return installStatus(found, FEEDS_VERSION);
}