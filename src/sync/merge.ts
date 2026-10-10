import { appDb, type ReaderDB } from "../db/db";
import { newer, type Annotation, type Folder, type Item, type Position } from "../model";
import { buildIndex, serializeIndex } from "./indexfile";
import { parseItem, serializeItem } from "./itemfile";
import { itemPath } from "./paths";

/*
 * Each synced record has an id and an updatedAt. Merging is per record: the newer edit wins,
 * and deletions are tombstones. Merging is order-independent, so two devices (or two people)
 * writing at the same time always converge without losing anything.
 */

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

/** Merge one item file from the repository. Returns null if the file isn't an Engram item. */
export async function mergeItemFile(db: ReaderDB, path: string, text: string): Promise<ItemMerge | null> {
  const parsed = parseItem(text, path);
  if (!parsed) return null;
  const { item, annotations } = parsed;
  return db.transaction("rw", db.items, db.annotations, async () => {
    const local = await db.items.get(item.id);
    let orphan: string | undefined;
    let canonical = path;
    if (local && local.path !== path) {
      canonical = local.path < path ? local.path : path;
      orphan = canonical === path ? local.path : path;
      if (canonical !== local.path) await db.items.update(item.id, { path: canonical });
    }
    const localItem = local ? { ...local, path: canonical } : undefined;
    const itemAhead = await mergeRecords([{ ...item, path: canonical }], localItem ? [localItem] : [], (i) => i.id, (r) =>
      db.items.bulkPut(r),
    );
    const annAhead = await mergeRecords(
      annotations,
      await db.annotations.where("doc").equals(item.id).toArray(),
      (a) => a.id,
      (r) => db.annotations.bulkPut(r),
    );
    return { id: item.id, path: canonical, localAhead: itemAhead || annAhead || canonical !== path, orphan };
  });
}

/**
 * Merge a first-layout library.json. Old folders, and tabs still running the old app, write
 * these; they keep merging in until every device is on items. Returns the item paths to push.
 */
export async function mergeLegacyLibrary(db: ReaderDB, text: string): Promise<string[]> {
  const file = JSON.parse(text) as LegacyLibraryFile;
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
  const file = JSON.parse(text) as LegacyAnnotationsFile;
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
  const file = JSON.parse(text) as PositionsFile;
  return db.transaction("rw", db.positions, async () =>
    mergeRecords(file.positions ?? [], await db.positions.toArray(), (p) => p.doc, (items) => db.positions.bulkPut(items)),
  );
}

export async function mergePeerPositions(db: ReaderDB, user: string, text: string): Promise<void> {
  const file = JSON.parse(text) as PositionsFile;
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
