import { create } from "zustand";
import type { ReaderDB } from "../db/db";
import type { RepoRef } from "../model";
import { getAccount, useAccount } from "./account";
import { GitHub, GitHubError } from "./github";
import {
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
import { FOLDER_FILE, INDEX_FILE, isLegacy, parsePath, pathPriority, pdfPath, positionsPath } from "./paths";

/** Bumped when the repository layout changes; 2 is one Markdown file per item, 3 adds index.json. */
const LAYOUT = 3;

/**
 * The index trails item edits: a burst of edits costs one index write, at most every couple of
 * minutes, so agents see changes soon without spending GitHub's write budget on every keystroke.
 */
const INDEX_DELAY_MS = 30_000;
const INDEX_MAX_WAIT_MS = 120_000;

export type SyncState = "local" | "synced" | "syncing" | "pending" | "offline" | "error" | "auth";

export interface FolderSync {
  state: SyncState;
  message?: string;
  lastSyncedAt?: number;
  pending: number;
}

/** Sync status of every folder, keyed by folder id. */
export const useSync = create<{ folders: Record<string, FolderSync> }>(() => ({ folders: {} }));

const IDLE: FolderSync = { state: "local", pending: 0 };

export const getFolderSync = (id: string) => useSync.getState().folders[id] ?? IDLE;

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
   * Queue a remote file for upload. Edits close together collapse into one commit:
   * each edit pushes the deadline out by `delayMs`, but never past `maxWaitMs` from the first edit.
   */
  async markDirty(path: string, delayMs: number, maxWaitMs = Math.max(delayMs * 4, 1)) {
    const now = Date.now();
    const db = this.db;
    await db.transaction("rw", db.outbox, async () => {
      const row = await db.outbox.get(path);
      const firstAt = row?.firstAt ?? now;
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

  /** Sync now: used when the tab hides or closes, and by the "Sync now" button. */
  async flush() {
    await this.db.outbox.toCollection().modify({ dueAt: 0 });
    this.wake();
    await this.tick(document.visibilityState === "hidden");
  }

  /** Fetch a PDF from GitHub on first open on this device. PDFs are only downloaded when needed. */
  async downloadPdf(doc: string): Promise<Blob | null> {
    if (!this.gh) return null;
    let sha = this.remote.shas[pdfPath(doc)];
    if (!sha) {
      this.forcePull = true;
      await this.tick();
      sha = this.remote.shas[pdfPath(doc)];
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
    if (Date.now() < this.backoffUntil) return;
    const visible = document.visibilityState === "visible";
    const pullDue = this.forcePull || (visible && Date.now() - this.lastPull > POLL_MS[this.attention]);
    const due = (await this.db.outbox.where("dueAt").belowOrEqual(Date.now()).toArray()).sort(
      (a, b) => pathPriority(a.path) - pathPriority(b.path),
    );
    if (!pullDue && due.length === 0) return;

    this.running = true;
    if (due.length > 0 || this.forcePull) setFolderSync(this.folderId, { state: "syncing" });
    try {
      let throttled = false;
      if (pullDue && (await this.pull())) throttled = !(await this.tidy());
      for (const row of due) throttled = !(await this.push(row.path, row.rev, keepalive)) || throttled;
      this.failures = 0;
      const pending = await this.db.outbox.count();
      setFolderSync(this.folderId, {
        state: pending ? "pending" : "synced",
        pending,
        message: throttled ? "Pacing uploads to stay inside GitHub's limits." : undefined,
        lastSyncedAt: Date.now(),
      });
    } catch (e) {
      this.handleError(e);
    } finally {
      this.running = false;
    }
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
        set({ state: "error", message: "Can't reach this folder's repository. Check you still have access to it on GitHub." });
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

  /** Fetch and merge what changed. Returns true if the repository still has files to tidy away. */
  private async pull(): Promise<boolean> {
    const gh = this.gh!;
    const db = this.db;
    this.lastPull = Date.now();
    const force = this.forcePull;
    this.forcePull = false;
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
    const tree = await gh.getTree(head.sha);
    const login = getAccount()?.login;
    const shas: Record<string, string> = {};
    for (const entry of tree) {
      const p = parsePath(entry.path);
      if (p.kind === "other") continue;
      shas[entry.path] = entry.sha;
      if (this.remote.shas[entry.path] === entry.sha || p.kind === "pdf" || p.kind === "index") continue;
      const text = await gh.getBlobText(entry.sha);
      if (p.kind === "folder") {
        if (await mergeFolder(this.folderId, text)) await this.markDirty(entry.path, 1_000);
      } else if (p.kind === "item") {
        const r = await mergeItemFile(db, entry.path, text);
        if (r?.localAhead) await this.markDirty(r.path, 1_000);
        if (r?.orphan) this.orphans.add(r.orphan);
        // Usually the writer's own index already covers this, and then the push is skipped.
        await this.markDirty(INDEX_FILE, INDEX_DELAY_MS, INDEX_MAX_WAIT_MS);
      } else if (p.kind === "legacyLibrary") {
        for (const path of await mergeLegacyLibrary(db, text)) await this.markDirty(path, 1_000);
      } else if (p.kind === "legacyAnnotations") {
        const path = await mergeLegacyAnnotations(db, p.doc, text);
        if (path) await this.markDirty(path, 1_000);
      } else if (p.kind === "positions") {
        if (p.user === login) {
          if (await mergeMyPositions(db, text)) await this.markDirty(entry.path, 1_000);
        } else await mergePeerPositions(db, p.user, text);
      }
    }
    this.remote = { ...this.remote, head: head.sha, etag: head.etag, shas };
    await this.saveRemote();
    return this.needsTidy();
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
      else this.remote.shas[f.path] = await gitBlobSha(f.text);
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

  private async mergeInto(path: string, text: string) {
    const p = parsePath(path);
    if (p.kind === "folder") await mergeFolder(this.folderId, text);
    else if (p.kind === "item") {
      const r = await mergeItemFile(this.db, path, text);
      if (r?.orphan) this.orphans.add(r.orphan);
    }
    else if (p.kind === "positions") await mergeMyPositions(this.db, text);
  }

  /** Push one file. Returns false if it was deferred to respect GitHub's write limits. */
  private async push(path: string, rev: number, keepalive: boolean): Promise<boolean> {
    const gh = this.gh!;
    const db = this.db;
    const p = parsePath(path);
    if (p.kind === "pdf") {
      if (!this.remote.shas[path]) {
        const blob = await db.blobs.get(p.doc);
        const meta = await db.items.get(p.doc);
        if (blob && !meta?.deleted) {
          if (!canWrite(4)) return false;
          this.remote.shas[path] = await gh.putBinary(path, blob.data, `Add ${meta?.title ?? "PDF"}`);
          recordWrites(4);
          await this.saveRemote();
        }
      }
    } else {
      for (let attempt = 0; ; attempt++) {
        const text = await this.serialize(path);
        if (text === null) break;
        if ((await gitBlobSha(text)) === this.remote.shas[path]) break; // remote already has exactly this
        if (!canWrite(1)) return false;
        try {
          // keepalive requests are capped at 64 KB; larger bodies go as normal requests.
          const ka = keepalive && text.length < 48_000;
          this.remote.shas[path] = await gh.putFile(path, text, this.remote.shas[path], commitMessage(path), ka);
          recordWrites(1);
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

The app manages these files. Editing them by hand is safe but rarely needed.
`;
