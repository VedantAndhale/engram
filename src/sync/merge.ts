import { appDb, type ReaderDB } from "../db/db";
import { newer, type Annotation, type DocMeta, type Folder, type Position } from "../model";

/*
 * Each synced file is a set of items with an id and an updatedAt. Merging is per item:
 * the newer edit wins, and deletions are tombstones. Merging is order-independent, so two
 * devices (or two people) writing at the same time always converge without losing anything.
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

interface LibraryFile {
  format: "reader/library@1";
  docs: DocMeta[];
}
interface AnnotationsFile {
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

export async function serializeLibrary(db: ReaderDB): Promise<string> {
  const docs = (await db.docs.toArray()).sort(byKey((d) => d.hash));
  return stable({ format: "reader/library@1", docs } satisfies LibraryFile);
}

export async function serializeAnnotations(db: ReaderDB, doc: string): Promise<string> {
  const items = (await db.annotations.where("doc").equals(doc).toArray()).sort(byKey((a) => a.id));
  return stable({ format: "reader/annotations@1", doc, items } satisfies AnnotationsFile);
}

export async function serializePositions(db: ReaderDB, user: string): Promise<string> {
  const positions = (await db.positions.toArray()).sort(byKey((p) => p.doc));
  return stable({ format: "reader/positions@1", user, positions } satisfies PositionsFile);
}

/**
 * Merge a remote item list into a local table. Returns true if the local side has
 * something the remote lacks (so this file still needs a push).
 */
async function mergeItems<T extends { updatedAt: number }>(
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

export async function mergeLibrary(db: ReaderDB, text: string): Promise<boolean> {
  const file = JSON.parse(text) as LibraryFile;
  return db.transaction("rw", db.docs, async () =>
    mergeItems(file.docs ?? [], await db.docs.toArray(), (d) => d.hash, (items) => db.docs.bulkPut(items)),
  );
}

export async function mergeAnnotations(db: ReaderDB, doc: string, text: string): Promise<boolean> {
  const file = JSON.parse(text) as AnnotationsFile;
  return db.transaction("rw", db.annotations, async () =>
    mergeItems(
      (file.items ?? []).filter((a) => a.doc === doc),
      await db.annotations.where("doc").equals(doc).toArray(),
      (a) => a.id,
      (items) => db.annotations.bulkPut(items),
    ),
  );
}

export async function mergeMyPositions(db: ReaderDB, text: string): Promise<boolean> {
  const file = JSON.parse(text) as PositionsFile;
  return db.transaction("rw", db.positions, async () =>
    mergeItems(file.positions ?? [], await db.positions.toArray(), (p) => p.doc, (items) => db.positions.bulkPut(items)),
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
