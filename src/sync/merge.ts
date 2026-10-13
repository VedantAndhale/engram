import { appDb, type ReaderDB } from "../db/db";
import { newer, type Annotation, type Folder, type Item, type Position } from "../model";
import { buildIndex, serializeIndex } from "./indexfile";
import { parseItem, serializeItem } from "./itemfile";
import { mergeAnnotations, mergeItem, sameItem } from "./itemmerge";
import { itemPath } from "./paths";

/*
 * Each synced record has an id and an updatedAt, and deletions are tombstones. Items and their
 * annotations merge field by field against the version both sides last agreed on (see
 * itemmerge.ts), so two devices editing the same note at once both keep their words. Positions
 * and the first layout's files merge per record: the newer edit wins.
 */

/** A file in the repository that isn't valid JSON (or not the shape we expect). Sync skips it. */
export class BadFileError extends Error {}

function parseJson<T>(text: string, check: (v: T) => boolean): T {
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch (e) {
    throw new BadFileError(e instanceof Error ? e.message : String(e));
  }
  if (!value || typeof value !== "object" || !check(value)) throw new BadFileError("not the expected format");
  return value;
}

const validPositions = (f: PositionsFile) =>
  f.positions === undefined || (Array.isArray(f.positions) && f.positions.every((p) => p && typeof p.doc === "string" && typeof p.updatedAt === "number"));

/** reader.json: marks a repository as a Reader folder and carries its id and name. */
export interface FolderFile {
  format: "reader/folder@1";
  id: string;
  name: string;
  updatedAt: number;
}

export function parseFolderFile(text: string): FolderFile | null {
  try {
    const f = JSON.parse(text) as FolderFile;
    return f.format === "reader/folder@1" && typeof f.id === "string" && typeof f.name === "string" ? f : null;
  } catch {
    return null;
  }
}

/** The first layout's document record, before items. */
interface LegacyDoc extends Omit<Item, "id" | "type" | "path"> {
  hash: string;
}
interface LegacyLibraryFile {
  format: "reader/library@1";
  docs: LegacyDoc[];
}
interface LegacyAnnotationsFile {
  format: "reader/annotations@1";
  doc: string;
  items: Annotation[];
}
interface PositionsFile {
  format: "reader/positions@1";
  user: string;
  positions: Position[];
}

const byKey = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Stable JSON so identical content always produces the identical git blob. */
function stable(value: unknown): string {
  return JSON.stringify(value, null, 1) + "\n";
}

export async function serializeFolder(folderId: string): Promise<string | null> {
  const f = await appDb.folders.get(folderId);
  if (!f) return null;
  return stable({ format: "reader/folder@1", id: f.id, name: f.name, updatedAt: f.updatedAt } satisfies FolderFile);
}

/** A rename made on another device wins if it is newer. Returns true if ours is newer. */
export async function mergeFolder(folderId: string, text: string): Promise<boolean> {
  const remote = parseFolderFile(text);
  const local = await appDb.folders.get(folderId);
  if (!remote || !local) return false;
  if (remote.updatedAt > local.updatedAt) {
    await appDb.folders.update(folderId, { name: remote.name, updatedAt: remote.updatedAt } satisfies Partial<Folder>);
    return false;
  }
  return local.updatedAt > remote.updatedAt || local.name !== remote.name;
}

/** The Markdown file for the item stored at `path`, or null if no item lives there. */
export async function serializeItemFile(db: ReaderDB, path: string): Promise<string | null> {
  const item = await db.items.where("path").equals(path).first();
  if (!item) return null;
  return serializeItem(item, await db.annotations.where("doc").equals(item.id).toArray());
}

/** index.json, rebuilt from everything in the folder. */
export async function serializeIndexFile(folderId: string, db: ReaderDB): Promise<string | null> {
  const f = await appDb.folders.get(folderId);
  if (!f) return null;
  return serializeIndex(buildIndex({ id: f.id, name: f.name }, await db.items.toArray(), await db.annotations.toArray()));
}

export async function serializePositions(db: ReaderDB, user: string): Promise<string> {
  const positions = (await db.positions.toArray()).sort(byKey((p) => p.doc));
  return stable({ format: "reader/positions@1", user, positions } satisfies PositionsFile);
}

/**
 * Merge a remote record list into a local table. Returns true if the local side has
 * something the remote lacks (so this file still needs a push).
 */
async function mergeRecords<T extends { updatedAt: number }>(
  remote: T[],
  local: T[],
  key: (t: T) => string,
  put: (items: T[]) => Promise<unknown>,
): Promise<boolean> {
  const localMap = new Map(local.map((l) => [key(l), l]));
  const remoteMap = new Map(remote.map((r) => [key(r), r]));
  const toPut: T[] = [];
  for (const r of remote) {
    const l = localMap.get(key(r));
    if (!l || newer(r, l)) toPut.push(r);
  }
  if (toPut.length) await put(toPut);
  for (const l of local) {
    const r = remoteMap.get(key(l));
    if (!r || newer(l, r)) return true;
  }
  return false;
}

export interface ItemMerge {
  id: string;
  /** Where this item lives now. */
  path: string;
  /** This device has changes the file lacks, so the file at `path` needs a push. */
  localAhead: boolean;
  /**
   * Set when two files hold the same item (two devices picked different paths, e.g. after a
   * rename raced a migration). The smaller path wins everywhere; this one should be removed.
   */
  orphan?: string;
}

/**
 * The version of an item file both sides last agreed on. Given this device's current file text,
 * returns the base text, or null if it can't be had (then the merge falls back to newer-wins).
 */
export type BaseLoader = (localText: string) => Promise<string | null>;

/**
 * Merge one item file from the repository. Returns null if the file isn't an Engram item.
 * `loadBase` is asked only when this device's version differs from the file.
 */
export async function mergeItemFile(db: ReaderDB, path: string, text: string, loadBase?: BaseLoader): Promise<ItemMerge | null> {
  const parsed = parseItem(text, path);
  if (!parsed) return null;
  const { item, annotations } = parsed;
  // Reading the base can mean a request to GitHub, which can't happen inside a transaction.
  let base: ReturnType<typeof parseItem> = null;
  const before = await db.items.get(item.id);
  if (before && loadBase) {
    const localText = serializeItem(before, await db.annotations.where("doc").equals(item.id).toArray());
    if (localText !== text) {
      const baseText = await loadBase(localText);
      base = baseText === null ? null : parseItem(baseText, path);
      if (base?.item.id !== item.id) base = null;
    }
  }
  return db.transaction("rw", db.items, db.annotations, async () => {
    const local = await db.items.get(item.id);
    let orphan: string | undefined;
    let canonical = path;
    if (local && local.path !== path) {
      canonical = local.path < path ? local.path : path;
      orphan = canonical === path ? local.path : path;
      if (canonical !== local.path) await db.items.update(item.id, { path: canonical });
    }
    const remoteItem = { ...item, path: canonical };
    const localAnns = await db.annotations.where("doc").equals(item.id).toArray();
    if (!local) {
      await db.items.put(remoteItem);
      const ann = mergeAnnotations(undefined, localAnns, annotations);
      if (ann.put.length) await db.annotations.bulkPut(ann.put);
      return { id: item.id, path: canonical, localAhead: ann.localAhead || canonical !== path, orphan };
    }
    // Compare like with like: this device's records as the file would read back.
    const view = parseItem(serializeItem({ ...local, path: canonical }, localAnns), canonical)!;
    const merged = mergeItem(base?.item, view.item, remoteItem);
    let itemAhead = false;
    if (!sameItem(merged, view.item)) {
      // Keep this device's own values (untrimmed text, fields the file doesn't carry) where the merge kept them.
      const next = { ...local, path: canonical } as Record<string, unknown>;
      const m = merged as unknown as Record<string, unknown>;
      const v = view.item as unknown as Record<string, unknown>;
      for (const k of new Set([...Object.keys(m), ...Object.keys(v)])) {
        if (k === "path" || JSON.stringify(m[k]) === JSON.stringify(v[k])) continue;
        if (m[k] === undefined) delete next[k];
        else next[k] = m[k];
      }
      await db.items.put(next as unknown as Item);
    }
    if (!sameItem(merged, remoteItem)) itemAhead = true;
    const viewAnns = new Map(view.annotations.map((a) => [a.id, a]));
    // Annotations the file doesn't show (none today) are compared as stored.
    const localForMerge = localAnns.map((a) => viewAnns.get(a.id) ?? a);
    const ann = mergeAnnotations(base?.annotations, localForMerge, annotations);
    if (ann.put.length) await db.annotations.bulkPut(ann.put);
    return { id: item.id, path: canonical, localAhead: itemAhead || ann.localAhead || canonical !== path, orphan };
  });
}

/**
 * Merge a first-layout library.json. Old folders, and tabs still running the old app, write
 * these; they keep merging in until every device is on items. Returns the item paths to push.
 */
export async function mergeLegacyLibrary(db: ReaderDB, text: string): Promise<string[]> {
  const file = parseJson<LegacyLibraryFile>(
    text,
    (f) => f.docs === undefined || (Array.isArray(f.docs) && f.docs.every(
          (d) => d && typeof d.hash === "string" && typeof d.title === "string" && typeof d.addedAt === "number" && typeof d.updatedAt === "number",
        )),
  );
  return db.transaction("rw", db.items, async () => {
    const dirty: string[] = [];
    for (const { hash, ...d } of file.docs ?? []) {
      const local = await db.items.get(hash);
      const remote: Item = { id: hash, type: "pdf", ...d, path: local?.path ?? itemPath(hash, d.title, d.addedAt) };
      if (local && local.body) remote.body = local.body; // the old format had no body
      if (!local || newer(remote, local)) await db.items.put(remote);
      dirty.push(remote.path);
    }
    return dirty;
  });
}

/** Merge a first-layout annotations/<doc>.json. Returns the item path to push, if the item is known. */
export async function mergeLegacyAnnotations(db: ReaderDB, doc: string, text: string): Promise<string | null> {
  const file = parseJson<LegacyAnnotationsFile>(
    text,
    (f) => f.items === undefined || (Array.isArray(f.items) && f.items.every((a) => a && typeof a.id === "string" && typeof a.updatedAt === "number")),
  );
  return db.transaction("rw", db.items, db.annotations, async () => {
    await mergeRecords(
      (file.items ?? []).filter((a) => a.doc === doc),
      await db.annotations.where("doc").equals(doc).toArray(),
      (a) => a.id,
      (items) => db.annotations.bulkPut(items),
    );
    return (await db.items.get(doc))?.path ?? null;
  });
}

export async function mergeMyPositions(db: ReaderDB, text: string): Promise<boolean> {
  const file = parseJson<PositionsFile>(text, validPositions);
  return db.transaction("rw", db.positions, async () =>
    mergeRecords(file.positions ?? [], await db.positions.toArray(), (p) => p.doc, (items) => db.positions.bulkPut(items)),
  );
}

export async function mergePeerPositions(db: ReaderDB, user: string, text: string): Promise<void> {
  const file = parseJson<PositionsFile>(text, validPositions);
  await db.peers.bulkPut((file.positions ?? []).map((p) => ({ ...p, user, key: `${user}:${p.doc}` })));
}

/** Git's blob id for some text, so we can tell locally whether a push would change anything. */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
