import { create } from "zustand";
import { appDb, type OutboxRow, type ReaderDB } from "../db/db";
import { formatBytes } from "../lib/util";
import type { RepoRef } from "../model";
import { getAccount, useAccount } from "./account";
import { GitHub, GitHubError } from "./github";
import { parseInbox } from "./inboxfile";
import {
  BadFileError,
  type BaseLoader,
  gitBlobSha,
  mergeFolder,
  mergeItemFile,
  mergeLegacyAnnotations,
  mergeLegacyLibrary,
  mergeMyPositions,
  mergePeerPositions,
  serializeFolder,
  serializeIndexFile,
  serializeItemFile,
  serializePositions,
} from "./merge";
import { FOLDER_FILE, INDEX_FILE, isLegacy, MAX_PDF_BYTES, parsePath, pathPriority, pdfPath, positionsPath } from "./paths";

/** Shown when GitHub answers 404 or 403 for the folder repo. The Library offers to fix it. */
export const CANT_REACH_MESSAGE = "Can't reach this folder's repository. Check you still have access to it on GitHub.";

/** Bumped when the repository layout changes; 2 is one Markdown file per item, 3 adds index.json. */
const LAYOUT = 3;

/**
 * The index trails item edits: a burst of edits costs one index write, at most every couple of
 * minutes, so agents see changes soon without spending GitHub's write budget on every keystroke.
 */
const INDEX_DELAY_MS = 30_000;
const INDEX_MAX_WAIT_MS = 120_000;

/**
 * Catching up with the repository fetches this many changed files per tick, a few at a time,
 * saving progress as it goes: an interrupted first sync resumes where it stopped, and uploads
 * run between batches instead of waiting for the whole library.
 */
const PULL_BATCH = 120;
const PULL_PARALLEL = 6;

/** A file whose upload fails waits this long, doubling each time up to the max, while the rest sync. */
const FILE_BACKOFF_MS = 30_000;
const FILE_BACKOFF_MAX_MS = 60 * 60_000;
/** A file that can't go up as it is (too big) is looked at again this rarely, in case it changed. */
const BLOCKED_RECHECK_MS = 6 * 60 * 60_000;

/**
 * How long a "private" answer is trusted before the next push. Short on purpose: a repository made public
 * should stop receiving notes within seconds, not a quarter hour. Costs one request per window while pushing.
 */
const PRIVACY_CHECK_MS = 10_000;
const PUBLIC_RECHECK_MS = 60_000;
const PUBLIC_MESSAGE =
  "This folder's repository on GitHub is public, so Engram has paused syncing it to keep your notes private. Make the repository private on GitHub and syncing resumes by itself; your changes are safe on this device.";

/** Keepalive requests (sent as the tab closes) are capped at 64 KB of body, counted in bytes. */
const KEEPALIVE_MAX_BYTES = 60_000;

export type SyncState = "local" | "synced" | "syncing" | "pending" | "offline" | "error" | "auth";

export interface FolderSync {
  state: SyncState;
  message?: string;
  lastSyncedAt?: number;
  pending: number;
  /**
   * Files that failed to upload, by repository path (a PDF is at `pdfPath(doc)`), with the reason.
   * They retry on their own (except PDFs too big for GitHub); everything else keeps syncing.
   */
  problems?: Record<string, string>;
}

/** Sync status of every folder, keyed by folder id. */
export const useSync = create<{ folders: Record<string, FolderSync> }>(() => ({ folders: {} }));

const IDLE: FolderSync = { state: "local", pending: 0 };

export const getFolderSync = (id: string) => useSync.getState().folders[id] ?? IDLE;

/** Why a file (e.g. `pdfPath(doc)`) isn't on GitHub yet, if its upload failed. */
export const syncProblem = (folderId: string, path: string) => getFolderSync(folderId).problems?.[path];

function setFolderSync(id: string, patch: Partial<FolderSync>) {
  useSync.setState((s) => ({ folders: { ...s.folders, [id]: { ...(s.folders[id] ?? IDLE), ...patch } } }));
}

/** What we last saw on GitHub: head commit, its ETag, and the blob sha of every file. */
interface RemoteState {
  repoKey: string;
  head?: string;
  etag?: string;
  shas: Record<string, string>;
}

/** A pull that spans ticks: the commit being caught up to and the files in it. */
interface CatchUp {
  head: { sha: string; etag?: string };
  tree: { path: string; sha: string }[];
}

/** A PDF too big to store on GitHub. */
class FileTooLargeError extends Error {}

/**
 * GitHub allows ~80 content-creating requests a minute and 500 an hour, per user across all
 * repositories, so every folder's engine draws from this one shared budget.
 */
const WRITE_LIMITS = [
  { windowMs: 60_000, max: 60 },
  { windowMs: 3_600_000, max: 420 },
];
let writes: number[] = JSON.parse(localStorage.getItem("reader.writes") ?? "[]");

function canWrite(cost: number) {
  const now = Date.now();
  writes = writes.filter((t) => now - t < 3_600_000);
  return WRITE_LIMITS.every(({ windowMs, max }) => writes.filter((t) => now - t < windowMs).length + cost <= max);
}

export function recordWrites(cost: number) {
  for (let i = 0; i < cost; i++) writes.push(Date.now());
  localStorage.setItem("reader.writes", JSON.stringify(writes));
}

/**
 * GitHub allows 5,000 API requests an hour. Bulk reads (catching up with a repository) stop
 * short of that, leaving room for polling, discovery and uploads; they resume as the hour rolls on.
 */
const READS_PER_HOUR = 4_000;
let reads: number[] = [];

function readsLeft() {
  const now = Date.now();
  reads = reads.filter((t) => now - t < 3_600_000);
  return Math.max(0, READS_PER_HOUR - reads.length);
}

function recordReads(cost: number) {
  for (let i = 0; i < cost; i++) reads.push(Date.now());
}

/** Recently seen file versions by blob sha: the base for a three-way merge without a refetch. */
const MAX_CACHED_CHARS = 4_000_000;

/**
 * How often to check a folder's repo for other people's changes. Unchanged checks cost nothing
 * (they come back 304), but background folders still back off so many folders stay cheap.
 */
export type Attention = "reading" | "open" | "background";
const POLL_MS: Record<Attention, number> = { reading: 5_000, open: 20_000, background: 120_000 };

/** Moves one folder's local database to and from its GitHub repository. */
export class SyncEngine {
  private gh: GitHub | null = null;
  private remote: RemoteState = { repoKey: "", shas: {} };
  private running = false;
  private lastPull = 0;
  private forcePull = true;
  private backoffUntil = 0;
  private failures = 0;
  /** Duplicate item files found while pulling, to remove in the next tidy-up commit. */
  private orphans = new Set<string>();
  private catchUp: CatchUp | null = null;
  /** Files left to fetch before the pull in progress is complete. */
  private pullLeft = 0;
  /** Files uploaded while catching up: the commit being caught up to holds an older version. */
  private pushedDuringCatchUp = new Set<string>();
  /** Repository files that couldn't be read (malformed JSON): skipped until they change. */
  private badFiles = new Set<string>();
  private texts = new Map<string, string>();
  private textChars = 0;
  /** The repository turned out to be public: nothing is pushed or pulled until it is private again. */
  private isPublic = false;
  private privacyCheckedAt = 0;
  attention: Attention = "background";

  constructor(
    readonly folderId: string,
    readonly db: ReaderDB,
  ) {}

  get connected() {
    return this.gh !== null;
  }

  /** Point the engine at the folder's repository, or detach it (no repo, or signed out). */
  async attach(repo: RepoRef | undefined) {
    if ((await this.db.kvGet<number>("layout")) !== LAYOUT) {
      // First run after an upgrade: changes queued for the old files belong in item files now.
      await this.db.outbox.filter((r) => isLegacy(r.path)).delete();
      await this.markEverythingDirty();
      await this.db.kvSet("layout", LAYOUT);
    }
    const account = getAccount();
    this.catchUp = null;
    this.pushedDuringCatchUp.clear();
    if (!repo || !account) {
      this.gh = null;
      setFolderSync(this.folderId, { state: "local", message: undefined });
      await this.refreshPending();
      return;
    }
    this.gh = new GitHub(account.token, repo);
    const repoKey = `${repo.owner}/${repo.repo}@${repo.branch}`;
    const saved = await this.db.kvGet<RemoteState>("remote");
    if (saved?.repoKey !== repoKey) {
      // New repository for this folder: everything local still has to go up.
      this.remote = { repoKey, shas: {} };
      await this.markEverythingDirty();
    } else this.remote = saved;
    // Known public (from discovery): stay paused until the first check says otherwise.
    this.isPublic = (await appDb.folders.get(this.folderId))?.isPrivate === false;
    this.privacyCheckedAt = 0;
    this.forcePull = true;
    this.backoffUntil = 0;
    setFolderSync(this.folderId, { state: "syncing", message: undefined });
    await this.refreshPending();
  }

  /** Called when the tab comes back or the network returns. */
  wake() {
    this.forcePull = true;
    this.backoffUntil = 0;
  }

  /**
   * What discovery learned about the repository's visibility. A public repository pauses sync;
   * once it is private again sync picks up where it stopped.
   */
  notePrivacy(isPrivate: boolean) {
    const wasPublic = this.isPublic;
    this.isPublic = !isPrivate;
    this.privacyCheckedAt = Date.now();
    if (wasPublic && isPrivate) this.wake();
  }

  /**
   * Queue a remote file for upload. Edits close together collapse into one commit:
   * each edit pushes the deadline out by `delayMs`, but never past `maxWaitMs` from the first edit.
   */
  async markDirty(path: string, delayMs: number, maxWaitMs = Math.max(delayMs * 4, 1)) {
    const now = Date.now();
    const db = this.db;
    await db.transaction("rw", db.outbox, async () => {
      const row = await db.outbox.get(path);
      const firstAt = row?.firstAt ?? now;
      // A new change starts over: any earlier failure was for an older version.
      await db.outbox.put({
        path,
        rev: (row?.rev ?? 0) + 1,
        firstAt,
        dueAt: Math.min(now + delayMs, firstAt + maxWaitMs),
      });
    });
    if (parsePath(path).kind === "item") await this.markDirty(INDEX_FILE, INDEX_DELAY_MS, INDEX_MAX_WAIT_MS);
    else await this.refreshPending();
  }

  async markEverythingDirty() {
    const db = this.db;
    const login = getAccount()?.login;
    await this.markDirty(FOLDER_FILE, 0);
    await this.markDirty(INDEX_FILE, 0);
    for (const item of await db.items.toArray()) {
      if (item.type === "pdf" && !item.deleted && (await db.blobs.get(item.id))) await this.markDirty(pdfPath(item.id), 0);
      await this.markDirty(item.path, 0);
    }
    if (login && (await db.positions.count())) await this.markDirty(positionsPath(login), 0);
  }

  /**
   * Sync now: used by the "Sync now" button and when the tab hides or closes. Files waiting
   * after a failed upload retry only when asked (`retryFailed`); files too big never do.
   */
  async flush(retryFailed = true) {
    await this.db.outbox.filter((r) => !r.blocked && (retryFailed || !r.tries)).modify({ dueAt: 0 });
    this.wake();
    await this.tick(document.visibilityState === "hidden");
  }

  /** Fetch a PDF from GitHub on first open on this device. PDFs are only downloaded when needed. */
  async downloadPdf(doc: string): Promise<Blob | null> {
    if (!this.gh) return null;
    let sha = this.remote.shas[pdfPath(doc)] ?? this.catchUp?.tree.find((e) => e.path === pdfPath(doc))?.sha;
    if (!sha) {
      this.forcePull = true;
      await this.tick();
      sha = this.remote.shas[pdfPath(doc)] ?? this.catchUp?.tree.find((e) => e.path === pdfPath(doc))?.sha;
    }
    if (!sha || !this.gh) return null;
    const bytes = await this.gh.getBlobBytes(sha);
    const data = new Blob([bytes], { type: "application/pdf" });
    await this.db.blobs.put({ hash: doc, data, lastUsed: Date.now() });
    return data;
  }

  isUploaded(doc: string) {
    return !!this.remote.shas[pdfPath(doc)];
  }

  async refreshPending() {
    const pending = await this.db.outbox.count();
    const s = getFolderSync(this.folderId);
    let state = s.state;
    if (!this.gh) state = "local";
    else if (state === "synced" && pending > 0) state = "pending";
    else if (state === "pending" && pending === 0 && !s.message) state = "synced";
    setFolderSync(this.folderId, { pending, state });
  }

  async tick(keepalive = false) {
    if (!this.gh || this.running) return;
    if (!navigator.onLine) {
      if (getFolderSync(this.folderId).state !== "offline") setFolderSync(this.folderId, { state: "offline", message: undefined });
      return;
    }
    const now = Date.now();
    if (now < this.backoffUntil) return;
    if (this.isPublic && now - this.privacyCheckedAt < PUBLIC_RECHECK_MS) return;
    const visible = document.visibilityState === "visible";
    const pullDue = this.forcePull || (visible && now - this.lastPull > POLL_MS[this.attention]);
    const due = (await this.db.outbox.where("dueAt").belowOrEqual(now).toArray()).sort(
      (a, b) => pathPriority(a.path) - pathPriority(b.path),
    );
    if (!pullDue && due.length === 0 && !this.isPublic) return;

    this.running = true;
    if (due.length > 0 || this.forcePull) setFolderSync(this.folderId, { state: "syncing" });
    try {
      if (!(await this.checkPrivate())) return;
      let throttled = false;
      if (pullDue && (await this.pull())) throttled = !(await this.tidy());
      for (const row of due) {
        try {
          throttled = !(await this.push(row.path, row.rev, keepalive)) || throttled;
        } catch (e) {
          // One file failing waits on its own; only connection and repository errors stop the rest.
          if (await this.fileFailed(row, e)) throw e;
        }
      }
      this.failures = 0;
      await this.report(throttled);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.running = false;
    }
  }

  /** Publish where sync stands after a tick: pending files, failures, and anything to tell the reader. */
  private async report(throttled: boolean) {
    const rows = await this.db.outbox.toArray();
    const problems: Record<string, string> = {};
    for (const r of rows) if (r.error) problems[r.path] = r.error;
    const failed = Object.values(problems);
    const bad = [...this.badFiles];
    let message: string | undefined;
    if (this.pullLeft > 0) {
      message = `Downloading from GitHub: ${this.pullLeft.toLocaleString()} files to go.${
        readsLeft() === 0 ? " GitHub limits how fast this can go, so it continues within the hour." : ""
      }`;
    } else if (failed.length) {
      message = failed.length === 1 ? failed[0] : `${failed.length} files couldn't upload yet. ${failed[0]}`;
    } else if (bad.length) {
      message = `Engram couldn't read ${bad.length === 1 ? bad[0] : `${bad.length} files (${bad[0]}, …)`} in this folder's repository and skipped ${
        bad.length === 1 ? "it" : "them"
      }. Everything else syncs; fix or remove ${bad.length === 1 ? "it" : "them"} on GitHub.`;
    } else if (throttled) message = "Pacing uploads to stay inside GitHub's limits.";
    setFolderSync(this.folderId, {
      state: this.pullLeft > 0 ? "syncing" : rows.length ? "pending" : "synced",
      pending: rows.length,
      problems: failed.length ? problems : undefined,
      message,
      lastSyncedAt: Date.now(),
    });
  }

  /**
   * One file's upload failed. It waits longer each time while the rest of the folder carries on.
   * Returns true if the error is about the connection or the whole repository, so the tick stops.
   */
  private async fileFailed(row: OutboxRow, e: unknown): Promise<boolean> {
    if (e instanceof GitHubError && (e.isAuth || e.isRateLimit || e.status === 403 || e.status === 404)) return true;
    const tooBig = e instanceof FileTooLargeError;
    if (!tooBig) console.warn("upload failed", row.path, e);
    const reason = tooBig ? (e as Error).message : `Couldn't upload ${await this.label(row.path)} (${e instanceof Error ? e.message : String(e)}). Engram tries again on its own.`;
    const db = this.db;
    await db.transaction("rw", db.outbox, async () => {
      const cur = await db.outbox.get(row.path);
      if (!cur || cur.rev !== row.rev) return; // changed since: the new version gets a fresh try
      const tries = (cur.tries ?? 0) + 1;
      const wait = tooBig ? BLOCKED_RECHECK_MS : Math.min(FILE_BACKOFF_MAX_MS, FILE_BACKOFF_MS * 2 ** (tries - 1));
      await db.outbox.put({ ...cur, tries, dueAt: Date.now() + wait, error: reason, blocked: tooBig || undefined });
    });
    return e instanceof GitHubError && e.status === 0;
  }

  /** A file's name for messages: an item's title, or the file name. */
  private async label(path: string): Promise<string> {
    const p = parsePath(path);
    const item = p.kind === "pdf" ? await this.db.items.get(p.doc) : p.kind === "item" ? await this.db.items.where("path").equals(path).first() : undefined;
    return item ? `“${item.title}”` : path.split("/").pop()!;
  }

  /**
   * Folder repositories must be private. Checks now and then (each check is one request) that this
   * one still is; a public repository pauses sync with a message until it is private again.
   */
  private async checkPrivate(): Promise<boolean> {
    const now = Date.now();
    if (now - this.privacyCheckedAt >= (this.isPublic ? PUBLIC_RECHECK_MS : PRIVACY_CHECK_MS)) {
      // The check time is recorded only once GitHub has answered. If the request fails, the old verdict is not
      // trusted: the error stops this tick, and the next tick checks again before anything is pushed.
      const repo = await this.gh!.getRepo();
      this.privacyCheckedAt = Date.now();
      recordReads(1);
      const wasPublic = this.isPublic;
      this.isPublic = !repo.private;
      if (wasPublic && repo.private) this.forcePull = true;
      const folder = await appDb.folders.get(this.folderId);
      if (folder && folder.isPrivate !== repo.private) await appDb.folders.update(this.folderId, { isPrivate: repo.private });
    }
    if (!this.isPublic) return true;
    setFolderSync(this.folderId, { state: "error", message: PUBLIC_MESSAGE, pending: await this.db.outbox.count() });
    return false;
  }

  private handleError(e: unknown) {
    this.failures++;
    const backoff = Math.min(5 * 60_000, 2_000 * 2 ** this.failures);
    const set = (patch: Partial<FolderSync>) => setFolderSync(this.folderId, patch);
    if (e instanceof GitHubError) {
      if (e.isAuth) {
        this.backoffUntil = Date.now() + 60_000;
        useAccount.setState({ authError: true });
        set({ state: "auth", message: "GitHub stopped accepting Engram's sign-in. Sign in again; changes are safe on this device." });
        return;
      }
      if (e.isRateLimit) {
        this.backoffUntil = e.retryAt!;
        set({ state: "pending", message: "GitHub asked us to slow down. Changes are safe on this device." });
        return;
      }
      if (e.status === 0) {
        this.backoffUntil = Date.now() + Math.min(60_000, backoff);
        set({ state: "offline", message: undefined });
        return;
      }
      if (e.status === 404 || e.status === 403) {
        this.backoffUntil = Date.now() + 60_000;
        set({ state: "error", message: CANT_REACH_MESSAGE });
        return;
      }
    }
    console.error("sync failed", e);
    this.backoffUntil = Date.now() + backoff;
    set({ state: "error", message: e instanceof Error ? e.message : String(e) });
  }

  private async saveRemote() {
    await this.db.kvSet("remote", this.remote);
  }

  /** Keep a file version we just saw or wrote, so a later merge has its base without a request. */
  private remember(sha: string, text: string) {
    if (this.texts.has(sha) || text.length > MAX_CACHED_CHARS / 4) return;
    this.texts.set(sha, text);
    this.textChars += text.length;
    for (const [k, v] of this.texts) {
      if (this.textChars <= MAX_CACHED_CHARS) break;
      this.texts.delete(k);
      this.textChars -= v.length;
    }
  }

  /**
   * The base for merging `path`: the version this device last synced (its sha is still in
   * `remote.shas` while the merge runs). Usually this device hasn't changed the file since, and
   * then its own text is the base; otherwise it comes from memory or costs one read.
   */
  private baseLoader(path: string): BaseLoader {
    const sha = this.remote.shas[path];
    return async (localText) => {
      if (!sha) return null;
      if ((await gitBlobSha(localText)) === sha) return localText;
      const cached = this.texts.get(sha);
      if (cached !== undefined) return cached;
      try {
        const text = await this.gh!.getBlobText(sha);
        recordReads(1);
        this.remember(sha, text);
        return text;
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 0 || e.isRateLimit || e.isAuth)) throw e;
        return null; // merge without a base: nothing is dropped, text is kept from both sides
      }
    };
  }

  /**
   * Fetch and merge what changed. Returns true if the repository still has files to tidy away.
   * A big change set is fetched over several ticks, saving progress after every few files.
   */
  private async pull(): Promise<boolean> {
    const gh = this.gh!;
    const db = this.db;
    this.lastPull = Date.now();
    const force = this.forcePull;
    this.forcePull = false;
    if (!this.catchUp) {
      const head = await gh.getHead(force ? undefined : this.remote.etag);
      if (head === null) return false;
      if (head === "empty") {
        // An adopted repository with no commits yet; the Git Data API needs at least one.
        await gh.putFile("README.md", README, undefined, "Set up Engram folder");
        recordWrites(1);
        this.forcePull = true;
        return false;
      }
      if (head.sha === this.remote.head) {
        this.remote.etag = head.etag;
        return this.needsTidy();
      }
      const tree = (await gh.getTree(head.sha)).filter((e) => parsePath(e.path).kind !== "other");
      recordReads(2);
      this.catchUp = { head, tree: tree.map(({ path, sha }) => ({ path, sha })) };
      this.pushedDuringCatchUp.clear();
    }
    const { head, tree } = this.catchUp;
    const todo = tree.filter((e) => {
      const k = parsePath(e.path).kind;
      return k !== "pdf" && k !== "index" && this.remote.shas[e.path] !== e.sha && !this.pushedDuringCatchUp.has(e.path);
    });
    const batch = todo.slice(0, Math.min(PULL_BATCH, readsLeft()));
    const login = getAccount()?.login;
    for (let i = 0; i < batch.length; i += PULL_PARALLEL) {
      const group = batch.slice(i, i + PULL_PARALLEL);
      const texts = await Promise.all(group.map((e) => this.texts.get(e.sha) ?? gh.getBlobText(e.sha)));
      recordReads(group.length);
      for (let j = 0; j < group.length; j++) {
        const { path, sha } = group[j];
        await this.mergeRemote(path, texts[j], login);
        this.remote.shas[path] = sha;
        this.remember(sha, texts[j]);
      }
      await this.saveRemote();
    }
    this.pullLeft = todo.length - batch.length;
    if (this.pullLeft > 0) {
      // More next tick, unless the read budget is spent: then the next regular poll carries on.
      this.forcePull = readsLeft() > 0;
      return false;
    }
    const shas: Record<string, string> = {};
    for (const e of tree) shas[e.path] = e.sha;
    for (const path of this.pushedDuringCatchUp) {
      if (this.remote.shas[path]) shas[path] = this.remote.shas[path];
      else delete shas[path];
    }
    // Inbox files gone from the repo were decided elsewhere (or here, and the delete went through).
    await db.inbox.filter((r) => !shas[r.path]).delete();
    for (const path of this.badFiles) if (!shas[path]) this.badFiles.delete(path);
    this.remote = { ...this.remote, head: head.sha, etag: head.etag, shas };
    this.catchUp = null;
    this.pushedDuringCatchUp.clear();
    await this.saveRemote();
    return this.needsTidy();
  }

  /** Merge one changed file from the repository. A file that can't be read is skipped and reported. */
  private async mergeRemote(path: string, text: string, login: string | undefined) {
    const db = this.db;
    const p = parsePath(path);
    try {
      if (p.kind === "folder") {
        if (await mergeFolder(this.folderId, text)) await this.markDirty(path, 1_000);
      } else if (p.kind === "item") {
        const r = await mergeItemFile(db, path, text, this.baseLoader(path));
        if (r?.localAhead) await this.markDirty(r.path, 1_000);
        if (r?.orphan) this.orphans.add(r.orphan);
        // Usually the writer's own index already covers this, and then the push is skipped.
        await this.markDirty(INDEX_FILE, INDEX_DELAY_MS, INDEX_MAX_WAIT_MS);
      } else if (p.kind === "legacyLibrary") {
        for (const item of await mergeLegacyLibrary(db, text)) await this.markDirty(item, 1_000);
      } else if (p.kind === "legacyAnnotations") {
        const item = await mergeLegacyAnnotations(db, p.doc, text);
        if (item) await this.markDirty(item, 1_000);
      } else if (p.kind === "inbox") {
        // Agents' files never change once made; one you already decided on stays decided.
        const sent = parseInbox(text);
        if (sent && !(await db.inbox.get(path))) await db.inbox.put({ path, entry: sent });
      } else if (p.kind === "positions") {
        if (p.user === login) {
          if (await mergeMyPositions(db, text)) await this.markDirty(path, 1_000);
        } else await mergePeerPositions(db, p.user, text);
      }
      this.badFiles.delete(path);
    } catch (e) {
      if (!(e instanceof BadFileError)) throw e;
      console.warn("skipped unreadable file", path, e.message);
      this.badFiles.add(path);
    }
  }

  private needsTidy() {
    for (const path of this.orphans) if (!this.remote.shas[path]) this.orphans.delete(path);
    return this.orphans.size > 0 || Object.keys(this.remote.shas).some(isLegacy);
  }

  /**
   * Move the repository onto the current layout in one commit: write every item file that
   * differs, and delete the old-layout files and duplicate item files. Runs right after a pull,
   * so everything in the old files has already been merged in. Returns false if deferred.
   */
  private async tidy(): Promise<boolean> {
    const gh = this.gh!;
    const db = this.db;
    if (!canWrite(3)) return false;
    const files: { path: string; text: string | null }[] = [];
    for (const item of await db.items.toArray()) {
      const text = await serializeItemFile(db, item.path);
      if (text !== null && (await gitBlobSha(text)) !== this.remote.shas[item.path]) files.push({ path: item.path, text });
    }
    const gone = Object.keys(this.remote.shas).filter((p) => isLegacy(p) || this.orphans.has(p));
    for (const path of gone) files.push({ path, text: null });
    const legacy = gone.some(isLegacy);
    const ok = await gh.commitFiles(files, legacy ? "Move to one Markdown file per item" : "Remove duplicate item files", this.remote.head!);
    recordWrites(3);
    this.forcePull = true;
    if (!ok) return true; // someone pushed meanwhile: pull again next tick and retry
    for (const f of files) {
      if (f.text === null) delete this.remote.shas[f.path];
      else {
        const sha = await gitBlobSha(f.text);
        this.remote.shas[f.path] = sha;
        this.remember(sha, f.text);
      }
    }
    this.orphans.clear();
    await this.saveRemote();
    return true;
  }

  private async serialize(path: string): Promise<string | null> {
    const p = parsePath(path);
    if (p.kind === "folder") return serializeFolder(this.folderId);
    if (p.kind === "item") return serializeItemFile(this.db, path);
    if (p.kind === "index") return serializeIndexFile(this.folderId, this.db);
    if (p.kind === "positions") return serializePositions(this.db, p.user);
    return null;
  }

  /** Merge the repository's version of a file we failed to write. A malformed one is simply replaced. */
  private async mergeInto(path: string, text: string) {
    const p = parsePath(path);
    try {
      if (p.kind === "folder") await mergeFolder(this.folderId, text);
      else if (p.kind === "item") {
        const r = await mergeItemFile(this.db, path, text, this.baseLoader(path));
        if (r?.orphan) this.orphans.add(r.orphan);
      } else if (p.kind === "positions") await mergeMyPositions(this.db, text);
    } catch (e) {
      if (!(e instanceof BadFileError)) throw e;
    }
  }

  /** Note an upload, so a pull still catching up doesn't treat the file's older version as news. */
  private uploaded(path: string) {
    if (this.catchUp) this.pushedDuringCatchUp.add(path);
  }

  /** Push one file. Returns false if it was deferred to respect GitHub's write limits. */
  private async push(path: string, rev: number, keepalive: boolean): Promise<boolean> {
    const gh = this.gh!;
    const db = this.db;
    const p = parsePath(path);
    if (p.kind === "inbox") {
      // The app only ever deletes inbox files, once you've accepted or dismissed them.
      const row = await db.inbox.get(path);
      const sha = this.remote.shas[path];
      if (row?.resolved && sha) {
        if (!canWrite(1)) return false;
        await gh.deleteFile(path, sha, `Inbox: ${row.resolved} ${row.entry.title ?? row.entry.targetTitle ?? "item"}`);
        recordWrites(1);
        delete this.remote.shas[path];
        this.uploaded(path);
        await this.saveRemote();
      }
      if (row?.resolved) await db.inbox.delete(path);
    } else if (p.kind === "pdf") {
      const sha = this.remote.shas[path];
      // Deleted for good: the file goes from the repository too.
      if (sha && (await db.items.get(p.doc))?.purged) {
        if (!canWrite(1)) return false;
        await gh.deleteFile(path, sha, "Delete a PDF for good");
        recordWrites(1);
        delete this.remote.shas[path];
        this.uploaded(path);
        await this.saveRemote();
      } else if (!sha) {
        const blob = await db.blobs.get(p.doc);
        const meta = await db.items.get(p.doc);
        if (blob && !meta?.deleted) {
          if (blob.data.size > MAX_PDF_BYTES) {
            throw new FileTooLargeError(
              `${meta ? `“${meta.title}”` : "A PDF"} is ${formatBytes(blob.data.size)}, more than the ${formatBytes(MAX_PDF_BYTES)} GitHub can take, so it stays on this device only. Its highlights and notes still sync.`,
            );
          }
          if (!canWrite(4)) return false;
          this.remote.shas[path] = await gh.putBinary(path, blob.data, `Add ${meta?.title ?? "PDF"}`);
          recordWrites(4);
          this.uploaded(path);
          await this.saveRemote();
        }
      }
    } else {
      for (let attempt = 0; ; attempt++) {
        // Check the budget before building the file: a throttled tick then costs nothing, rather
        // than re-serializing every waiting file (and the whole index) each second.
        if (!canWrite(1)) return false;
        const text = await this.serialize(path);
        if (text === null) break;
        const sha = await gitBlobSha(text);
        if (sha === this.remote.shas[path]) break; // remote already has exactly this
        try {
          const bytes = new TextEncoder().encode(text).length;
          // The body goes base64-encoded (4 bytes per 3) inside JSON.
          const ka = keepalive && Math.ceil(bytes / 3) * 4 + 1_000 < KEEPALIVE_MAX_BYTES;
          this.remote.shas[path] = await gh.putFile(path, text, this.remote.shas[path], commitMessage(path), ka);
          recordWrites(1);
          this.remember(this.remote.shas[path], text);
          this.uploaded(path);
          await this.saveRemote();
          break;
        } catch (e) {
          // Someone else changed this file since we last saw it: merge their version and try again.
          if (!(e instanceof GitHubError && e.isConflict) || attempt >= 4) throw e;
          recordWrites(1);
          const remote = await gh.getFile(path);
          if (remote) {
            await this.mergeInto(path, remote.text);
            this.remote.shas[path] = remote.sha;
            this.remember(remote.sha, remote.text);
          } else delete this.remote.shas[path];
        }
      }
    }
    await db.transaction("rw", db.outbox, async () => {
      const row = await db.outbox.get(path);
      if (row && row.rev === rev) await db.outbox.delete(path);
    });
    return true;
  }
}

function commitMessage(path: string) {
  const p = parsePath(path);
  if (p.kind === "folder") return "Update folder details";
  if (p.kind === "index") return "Update search index";
  if (p.kind === "positions") return `Update reading position (${p.user})`;
  return `Update ${path.split("/").pop()}`;
}

const README = `# Engram folder

This private repository is one folder of an Engram library: what you saved, your highlights and notes, and reading positions.

- \`reader.json\`: the folder's id and name
- \`items/<year>/<month>/<title>-<id>.md\`: one Markdown file per item. The front matter holds its
  details, the body holds your own words, and its highlights follow at the end.
- \`index.json\`: your notes and highlights in one compact file, for agents to search (rebuilt by the app)
- \`pdfs/<sha256>.pdf\`: each PDF, stored once and listed in its item's \`attachments\`
- \`positions/<github-user>.json\`: where each person is in each document

## Editing by hand

The app manages these files, but you can edit item files in Obsidian, on GitHub or in any editor,
and Engram picks these changes up:

- \`title\` and \`topics\` in the front matter
- your own words: everything between the front matter and the first \`<!-- engram:\` line
- the note under a highlight: the text after its \`^a1b2c3\` line
- the text under "Saved from the source"

Everything else is rewritten from the app's own records, so changes there don't stick: a
highlight's quoted text, the \`<!-- engram:… -->\` lines, and the other front matter. Leave those
lines in place; to remove a highlight, delete it in the app. \`index.json\` and \`positions/\` are
rewritten by the app. If the app and your editor change the same lines at once, both versions are
kept, between \`<<<<<<<\` and \`>>>>>>>\` lines, for you to tidy up.

To browse this folder in Obsidian, clone the repository and open it as a vault: \`[[Title]]\` links,
highlight links (\`[[Title#^a1b2c3]]\`) and embeds work there too.
`;
