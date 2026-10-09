import Dexie from "dexie";
import { appDb, folderDbName, ReaderDB } from "../db/db";
import { uid } from "../lib/util";
import type { Folder, RepoRef } from "../model";
import { LibrarySearch, type SearchHit } from "../search/index";
import { getAccount, saveAccount } from "../sync/account";
import { type Attention, getFolderSync, recordWrites, SyncEngine } from "../sync/engine";
import { FOLDER_DESCRIPTION_PREFIX, GitHub, GitHubError, tokenKind, type RepoSummary } from "../sync/github";
import { parseFolderFile } from "../sync/merge";
import { FOLDER_FILE } from "../sync/paths";

/** Everything needed to work inside one folder: its database, its sync engine and its search index. */
export interface FolderCtx {
  id: string;
  db: ReaderDB;
  sync: SyncEngine;
  search: LibrarySearch;
}

const ctxs = new Map<string, FolderCtx>();

export function folderCtx(id: string): FolderCtx {
  let ctx = ctxs.get(id);
  if (!ctx) {
    const db = new ReaderDB(folderDbName(id));
    ctx = { id, db, sync: new SyncEngine(id, db), search: new LibrarySearch(db) };
    ctxs.set(id, ctx);
  }
  return ctx;
}

export async function visibleFolders(): Promise<Folder[]> {
  const all = await appDb.folders.toArray();
  return all.filter((f) => !f.hidden).sort((a, b) => a.name.localeCompare(b.name));
}

const repoKey = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`.toLowerCase();
const refOf = (r: RepoSummary): RepoRef => ({ owner: r.owner.login, repo: r.name, branch: r.default_branch });

// ---------------------------------------------------------------------------------------------
// Start-up and scheduling
// ---------------------------------------------------------------------------------------------

let started = false;

export async function startFolders() {
  if (started) return;
  started = true;
  if ((await visibleFolders()).length === 0) await createFolder("My library");
  for (const f of await visibleFolders()) await folderCtx(f.id).sync.attach(f.repo);

  window.setInterval(() => {
    for (const ctx of ctxs.values()) void ctx.sync.tick();
  }, 1000);
  // Folders made while offline or signed out get their repository as soon as that is possible.
  window.setInterval(() => void ensureRepos(), 60_000);
  // New folders made on other devices, or shared with you, show up within a few minutes.
  window.setInterval(() => {
    if (document.visibilityState === "visible") void discoverFolders().catch(() => {});
  }, 5 * 60_000);

  const flushAll = () => {
    for (const ctx of ctxs.values()) void ctx.sync.flush();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
    else for (const ctx of ctxs.values()) ctx.sync.wake();
  });
  window.addEventListener("pagehide", flushAll);
  window.addEventListener("online", () => {
    for (const ctx of ctxs.values()) ctx.sync.wake();
  });

  if (getAccount()) {
    void discoverFolders().catch(() => {});
    void ensureRepos();
  }
}

/** The folder on screen polls faster than the rest; the one being read polls fastest. */
export function setAttention(folderId: string | undefined, attention: Attention) {
  for (const ctx of ctxs.values()) ctx.sync.attention = ctx.id === folderId ? attention : "background";
}

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------

/** Create a folder. With an account connected it immediately gets its own private repository. */
export async function createFolder(name: string): Promise<Folder> {
  const now = Date.now();
  const folder: Folder = { id: uid(), name: name.trim() || "Untitled folder", createdAt: now, updatedAt: now };
  await appDb.folders.put(folder);
  await folderCtx(folder.id).sync.attach(undefined);
  if (getAccount()) await createRepoFor(folder);
  return (await appDb.folders.get(folder.id))!;
}

export async function renameFolder(id: string, name: string) {
  const folder = await appDb.folders.get(id);
  const clean = name.trim();
  if (!folder || !clean || clean === folder.name) return;
  await appDb.folders.update(id, { name: clean, updatedAt: Date.now() });
  const ctx = folderCtx(id);
  await ctx.sync.markDirty(FOLDER_FILE, 1_000);
  // Keep the GitHub description readable; reader.json is what actually carries the name.
  const account = getAccount();
  if (account && folder.repo) void new GitHub(account.token, folder.repo).setDescription(clean).catch(() => {});
}

/**
 * Remove a folder from this device. Its repository stays on GitHub (deleting repos would need
 * a far more powerful token), and discovery won't bring it back here.
 */
export async function removeFolder(id: string) {
  const folder = await appDb.folders.get(id);
  if (!folder) return;
  const ctx = folderCtx(id);
  await ctx.sync.attach(undefined);
  ctxs.delete(id);
  ctx.db.close();
  await Dexie.delete(folderDbName(id));
  if (folder.repo) await appDb.folders.update(id, { hidden: true });
  else await appDb.folders.delete(id);
  if ((await visibleFolders()).length === 0) await createFolder("My library");
}

/** Unsynced changes in a folder, so the UI can warn before removing it. */
export async function pendingChanges(id: string): Promise<number> {
  return folderCtx(id).db.outbox.count();
}

function repoSlug(name: string) {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `reader-${slug || "folder"}`;
}

/** Friendly explanation for the usual reason repo creation fails: the token can't do it. */
export class RepoPermissionError extends Error {}

async function createRepoFor(folder: Folder): Promise<void> {
  const account = getAccount();
  if (!account || folder.repo) return;
  const gh = new GitHub(account.token);
  const base = repoSlug(folder.name);
  let created: RepoSummary | null = null;
  for (let n = 1; n <= 20 && !created; n++) {
    try {
      created = await gh.createRepo(n === 1 ? base : `${base}-${n}`, folder.name);
      recordWrites(1);
    } catch (e) {
      // 422: a repository with that name already exists, so try the next suffix.
      if (e instanceof GitHubError && e.status === 422) continue;
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !e.isRateLimit) {
        throw new RepoPermissionError(
          account.tokenKind === "fine-grained"
            ? 'Your token can\'t create repositories. On GitHub, edit the token: set Repository access to "All repositories" and Administration to "Read and write".'
            : 'Your token can\'t create repositories. It needs the "repo" scope.',
        );
      }
      throw e;
    }
  }
  if (!created) throw new Error("Couldn't find a free repository name for this folder.");
  if (!created.private) throw new Error("GitHub created the repository as public. Make it private before adding files.");
  await appDb.folders.update(folder.id, { repo: refOf(created), isPrivate: true });
  await folderCtx(folder.id).sync.attach(refOf(created));
}

let ensuring = false;

/** Give every folder that doesn't have a repository yet its own. Failures retry on the next run. */
export async function ensureRepos(): Promise<string | null> {
  if (ensuring || !getAccount() || !navigator.onLine) return null;
  ensuring = true;
  try {
    for (const f of await visibleFolders()) {
      if (f.repo) continue;
      try {
        await createRepoFor(f);
      } catch (e) {
        if (e instanceof RepoPermissionError) return e.message;
        console.warn("repo creation deferred", e);
      }
    }
    return null;
  } finally {
    ensuring = false;
  }
}

/**
 * Find folder repositories this account can reach: ones made on other devices, and ones
 * others shared with you. A repo counts only if its reader.json says it is a Reader folder.
 */
export async function discoverFolders(): Promise<number> {
  const account = getAccount();
  if (!account) return 0;
  const gh = new GitHub(account.token);
  const repos = await gh.listRepos();
  const folders = await appDb.folders.toArray();
  const byRepo = new Map(folders.filter((f) => f.repo).map((f) => [repoKey(f.repo!), f]));
  let added = 0;
  for (const r of repos) {
    if (!r.description?.startsWith(FOLDER_DESCRIPTION_PREFIX)) continue;
    const known = byRepo.get(repoKey({ owner: r.owner.login, repo: r.name }));
    if (known) {
      if (known.isPrivate !== r.private) await appDb.folders.update(known.id, { isPrivate: r.private });
      continue;
    }
    if (await addFolderFromRepo(gh, r)) added++;
  }
  return added;
}

async function addFolderFromRepo(gh: GitHub, r: RepoSummary): Promise<Folder | null> {
  const ref = refOf(r);
  const marker = await gh.getFile(FOLDER_FILE, ref);
  const file = marker ? parseFolderFile(marker.text) : null;
  if (!file) return null; // Not set up yet; another device is probably still creating it.
  const existing = await appDb.folders.get(file.id);
  if (existing?.hidden) return null;
  const folder: Folder = existing
    ? { ...existing, repo: ref, isPrivate: r.private } // the repo was renamed or moved
    : { id: file.id, name: file.name, repo: ref, isPrivate: r.private, createdAt: Date.now(), updatedAt: file.updatedAt };
  await appDb.folders.put(folder);
  await folderCtx(folder.id).sync.attach(ref);
  return folder;
}

/**
 * Add a repository someone shared with you, by "owner/name" or its GitHub URL.
 * Public repositories are refused: folders hold private reading.
 */
export async function adoptRepo(input: string): Promise<Folder> {
  const account = getAccount();
  if (!account) throw new Error("Connect GitHub first.");
  const m = /(?:github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) throw new Error('Enter the repository as "owner/name" or paste its GitHub link.');
  const gh = new GitHub(account.token);
  let r: RepoSummary;
  try {
    r = await gh.getRepo(m[1], m[2]);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) {
      throw new Error(
        account.tokenKind === "fine-grained"
          ? "Can't open that repository. Fine-grained tokens only reach repositories you own; for one shared with you, use a classic token."
          : "Can't open that repository. Check the name and that you've accepted the invitation.",
      );
    }
    throw e;
  }
  if (!r.private) throw new Error("That repository is public. Make it private on GitHub, then add it.");
  if (r.permissions && !r.permissions.push) throw new Error("You can read that repository but not write to it.");
  const known = (await appDb.folders.toArray()).find((f) => f.repo && repoKey(f.repo) === repoKey({ owner: r.owner.login, repo: r.name }));
  if (known) {
    if (known.hidden) {
      await appDb.folders.update(known.id, { hidden: false });
      await folderCtx(known.id).sync.attach(known.repo);
    }
    return (await appDb.folders.get(known.id))!;
  }
  const fromMarker = await addFolderFromRepo(gh, r);
  if (fromMarker) return fromMarker;
  // A plain repository: turn it into a folder. The engine writes reader.json on first sync.
  const now = Date.now();
  const folder: Folder = { id: uid(), name: r.name.replace(/^reader-/, ""), repo: refOf(r), isPrivate: true, createdAt: now, updatedAt: now };
  await appDb.folders.put(folder);
  await folderCtx(folder.id).sync.attach(folder.repo);
  return folder;
}

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

export interface ConnectResult {
  login: string;
  found: number;
  /** Set when folders couldn't get repositories, usually because of token permissions. */
  repoProblem: string | null;
}

/** Check a pasted token, save it, then link every folder to its repository. */
export async function connectAccount(rawToken: string): Promise<ConnectResult> {
  const token = rawToken.trim();
  const kind = tokenKind(token);
  const gh = new GitHub(token);
  let user: Awaited<ReturnType<GitHub["getUser"]>>;
  try {
    user = await gh.getUser();
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) throw new Error("GitHub didn't accept that token. Check it was copied in full.");
    if (e instanceof GitHubError && e.status === 0) throw new Error("Can't reach GitHub. Check your connection.");
    throw e;
  }
  if (kind === "classic" && !user.scopes.includes("repo")) {
    throw new Error('This classic token is missing the "repo" scope, which private repositories need.');
  }
  saveAccount({ token, login: user.login, name: user.name ?? undefined, avatarUrl: user.avatar_url, tokenKind: kind });

  const found = await discoverFolders();
  // A brand-new device starts with an empty "My library". If this account already has
  // folders, drop the empty placeholder instead of making a second repository for it.
  if (found > 0) {
    for (const f of await visibleFolders()) {
      if (!f.repo && (await folderCtx(f.id).db.docs.count()) === 0) await removeFolder(f.id);
    }
  }
  for (const f of await visibleFolders()) await folderCtx(f.id).sync.attach(f.repo);
  const repoProblem = await ensureRepos();
  return { login: user.login, found, repoProblem };
}

/** Sign out on this device. Folders and their files stay here; they reconnect when you sign in again. */
export async function disconnectAccount() {
  saveAccount(null);
  for (const ctx of ctxs.values()) await ctx.sync.attach(undefined);
}

/** True if any folder still has changes that haven't reached GitHub. */
export async function anyPending(): Promise<boolean> {
  for (const f of await visibleFolders()) if (getFolderSync(f.id).pending > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Search across folders
// ---------------------------------------------------------------------------------------------

export interface FolderHit extends SearchHit {
  folder: string;
}

export async function searchAll(query: string, limit = 60): Promise<FolderHit[]> {
  const folders = await visibleFolders();
  const results = await Promise.all(
    folders.map(async (f) => (await folderCtx(f.id).search.search(query, limit)).map((h) => ({ ...h, folder: f.id }))),
  );
  // Highlights and notes first (they are the reader's own words), then page matches.
  return results.flat().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "annotation" ? -1 : 1)).slice(0, limit * 2);
}
