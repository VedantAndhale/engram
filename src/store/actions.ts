import { dropItemAiNotes } from "../ai/notedrop";
import { folderCtx } from "../folders/registry";
import { extractText, inspectPdf, openPdf } from "../lib/pdf";
import { deviceId, deviceName, formatBytes, sha256Hex, uid } from "../lib/util";
import { isDailyNote, type Annotation, type Item, type Location, type Position } from "../model";
import { getAccount } from "../sync/account";
import { itemPath, MAX_PDF_BYTES, pdfPath, positionsPath } from "../sync/paths";
import { toast } from "./ui";

/*
 * Every user action writes to the folder's IndexedDB first (instant, works offline), then
 * queues the matching file in that folder's repository. Its sync engine uploads in the background.
 */

const login = () => getAccount()?.login;

/** Queue an item's file for upload after a change to it or its highlights. */
async function touchItem(folder: string, id: string, delayMs: number, maxWaitMs?: number) {
  const { db, sync } = folderCtx(folder);
  const item = await db.items.get(id);
  if (item) await sync.markDirty(item.path, delayMs, maxWaitMs);
}

/**
 * Change an item because you asked to. Each changed field is stamped with the time (`Item.edited`),
 * so if another device changed the same field meanwhile, the later edit by hand wins.
 */
export async function updateItem(folder: string, id: string, patch: Partial<Item>, delayMs = 1500, maxWaitMs?: number) {
  const { db } = folderCtx(folder);
  const now = Date.now();
  await db.transaction("rw", db.items, async () => {
    const cur = await db.items.get(id);
    if (!cur) return;
    const edited = { ...cur.edited };
    for (const k of Object.keys(patch)) if (k !== "edited" && k !== "updatedAt" && k !== "path") edited[k] = now;
    await db.items.update(id, { ...patch, edited, updatedAt: now });
  });
  await touchItem(folder, id, delayMs, maxWaitMs);
}

/**
 * Change an item in the background (filling in an article from the web, details found later).
 * Only fields still as they were in `seen` (the item the update was worked out from) change, and
 * no edit stamp is set, so neither a change you make meanwhile on this device nor one from
 * another device is ever overwritten by it.
 */
export async function fillItem(folder: string, id: string, patch: Partial<Item>, seen?: Item, delayMs = 500) {
  const { db } = folderCtx(folder);
  let changed = false;
  await db.transaction("rw", db.items, async () => {
    const cur = await db.items.get(id);
    if (!cur) return;
    const apply: Partial<Item> = {};
    for (const [k, v] of Object.entries(patch) as [keyof Item, unknown][]) {
      if (seen && JSON.stringify(cur[k]) !== JSON.stringify(seen[k])) continue;
      (apply as Record<string, unknown>)[k] = v;
    }
    if (!Object.keys(apply).length) return;
    await db.items.update(id, { ...apply, updatedAt: Date.now() });
    changed = true;
  });
  if (changed) await touchItem(folder, id, delayMs);
  return changed;
}

/** Your own words about an item. Saved as you type, so uploads wait for a pause. */
export async function setItemBody(folder: string, id: string, body: string) {
  await updateItem(folder, id, { body: body.trim() ? body : undefined }, 2_000, 8_000);
}

/**
 * Make a new item that isn't a PDF: a link, a quote, a note. `id` is only given for items every
 * device must agree on without talking, like a day's note.
 */
export async function createItem(folder: string, fields: Omit<Item, "id" | "path" | "addedAt" | "updatedAt">, id = uid()): Promise<Item> {
  const { db, sync } = folderCtx(folder);
  const now = Date.now();
  const item: Item = { id, ...fields, addedAt: now, addedBy: login(), updatedAt: now, path: itemPath(id, fields.title, now) };
  // New things land in the Inbox; a day's note lives under Today instead.
  if (!item.location && !isDailyNote(item)) item.location = "inbox";
  await db.items.put(item);
  await sync.markDirty(item.path, 500);
  void keepStorage();
  return item;
}

export async function addPdf(folder: string, file: File): Promise<string> {
  const { db, sync } = folderCtx(folder);
  const data = await file.arrayBuffer();
  const hash = await sha256Hex(data);
  const existing = await db.items.get(hash);
  if (existing && !existing.deleted) {
    await db.blobs.put({ hash, data: file, lastUsed: Date.now() });
    return hash;
  }
  const { title, pages, thumb, author, description } = await inspectPdf(data, file.name);
  const now = Date.now();
  const addedAt = existing?.addedAt ?? now;
  const item: Item = {
    ...existing,
    id: hash,
    type: "pdf",
    title: existing?.title ?? title,
    author: existing?.author ?? author,
    description: existing?.description ?? description,
    fileName: file.name,
    size: file.size,
    pages,
    addedAt,
    addedBy: login(),
    updatedAt: now,
    // Added again after it was deleted: back in the Inbox, as new.
    location: existing && !existing.deleted ? existing.location : "inbox",
    deleted: undefined,
    purged: undefined,
    path: existing?.path ?? itemPath(hash, existing?.title ?? title, addedAt),
  };
  await db.transaction("rw", [db.items, db.blobs, db.thumbs], async () => {
    await db.items.put(item);
    await db.blobs.put({ hash, data: new Blob([data], { type: "application/pdf" }), lastUsed: now });
    await db.thumbs.put({ hash, dataUrl: thumb });
  });
  await sync.markDirty(pdfPath(hash), 0);
  await sync.markDirty(item.path, 500);
  if (file.size > MAX_PDF_BYTES && getAccount()) {
    toast(
      `This PDF is ${formatBytes(file.size)}; GitHub takes files up to ${formatBytes(MAX_PDF_BYTES)}, so the PDF itself stays on this device. Its highlights and notes still sync.`,
    );
  }
  void indexDocument(folder, hash, data);
  void keepStorage();
  return hash;
}

/**
 * Ask the browser to keep this site's storage (Safari otherwise clears it after a week without a
 * visit). Asked at start-up and again once there is something to lose: some browsers only agree
 * after the site has been used.
 */
export async function keepStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Extract page text once per device for search. */
export async function indexDocument(folder: string, hash: string, data?: ArrayBuffer) {
  const { db, search } = folderCtx(folder);
  if (await db.pageText.where("doc").equals(hash).count()) return;
  const buf = data ?? (await (await db.blobs.get(hash))?.data.arrayBuffer());
  if (!buf) return;
  const pdf = await openPdf(buf);
  try {
    await extractText(pdf, async (page, text) => {
      await db.pageText.put({ doc: hash, page, text });
      await search.addPage(hash, page, text);
    });
  } finally {
    void pdf.loadingTask.destroy();
  }
}

/** Thumbnails are local-only; make one on demand for documents that arrived from another device. */
export async function ensureThumb(folder: string, hash: string, data: ArrayBuffer) {
  const { db } = folderCtx(folder);
  if (await db.thumbs.get(hash)) return;
  const item = await db.items.get(hash);
  const { thumb } = await inspectPdf(data, item?.fileName ?? "document.pdf");
  await db.thumbs.put({ hash, dataUrl: thumb });
}

/** Renaming keeps the item's file where it is, so other devices never see it move. */
export async function renameItem(folder: string, id: string, title: string) {
  const clean = title.trim();
  if (clean) await updateItem(folder, id, { title: clean });
}

export async function setItemTopics(folder: string, id: string, topics: string[]) {
  await updateItem(folder, id, { topics: topics.length ? topics : undefined });
}

export async function removeItem(folder: string, id: string) {
  await updateItem(folder, id, { deleted: true }, 500);
}

export async function restoreItem(folder: string, id: string) {
  await updateItem(folder, id, { deleted: undefined }, 500);
}

/** Move items to the Inbox, Later or the Archive. */
export async function setLocation(folder: string, ids: string[], location: Location) {
  for (const id of ids) await updateItem(folder, id, { location }, 500);
}

export async function setFavorite(folder: string, id: string, favorite: boolean) {
  await updateItem(folder, id, { favorite: favorite || undefined }, 500);
}

/** True when a reading position is at (or near) the end of the item. */
export function isFinished(item: Pick<Item, "type" | "pages">, p: Pick<Position, "page" | "offset"> | undefined): boolean {
  if (!p) return false;
  if (item.type === "pdf") {
    const pages = item.pages ?? 0;
    return pages > 0 && (p.page >= pages || (p.page - 1 + p.offset) / pages >= 0.9);
  }
  return p.page === 0 && p.offset >= 0.9;
}

/** Note when an item is first read to the end. It stays where it is in the library. */
async function noteFinished(folder: string, doc: string, page: number, offset: number) {
  const item = await folderCtx(folder).db.items.get(doc);
  if (!item || item.readAt || item.deleted || !isFinished(item, { page, offset })) return;
  await updateItem(folder, doc, { readAt: Date.now() }, 1_500);
}

/** Fields that are the item's bookkeeping rather than what it holds. */
const BOOKKEEPING = new Set(["id", "type", "path", "addedAt", "updatedAt", "edited"]);

/**
 * Delete an item for good: its words, saved text, highlights and file go, from this device and
 * from GitHub. A bare tombstone stays in its file, so every other device deletes it too.
 */
export async function purgeItem(folder: string, id: string) {
  const { db, sync } = folderCtx(folder);
  const now = Date.now();
  const cur = await db.items.get(id);
  if (!cur) return;
  const edited = { ...cur.edited };
  for (const k of Object.keys(cur)) if (!BOOKKEEPING.has(k)) edited[k] = now;
  edited.title = edited.deleted = edited.purged = now;
  const tombstone: Item = { id, type: cur.type, title: "Deleted", addedAt: cur.addedAt, updatedAt: now, deleted: true, purged: true, edited, path: cur.path };
  await db.transaction("rw", [db.items, db.annotations, db.blobs, db.thumbs, db.pageText], async () => {
    await db.items.put(tombstone);
    const marks = await db.annotations.where("doc").equals(id).toArray();
    // Each highlight keeps only what says it was deleted.
    await db.annotations.bulkPut(marks.map((a) => ({ id: a.id, doc: a.doc, kind: a.kind, page: a.page, color: a.color, createdAt: a.createdAt, updatedAt: now, deleted: true })));
    await db.blobs.delete(id);
    await db.thumbs.delete(id);
    await db.pageText.where("doc").equals(id).delete();
  });
  await dropItemAiNotes(id);
  await sync.markDirty(cur.path, 500);
  if (cur.type === "pdf") await sync.markDirty(pdfPath(id), 0);
}

/**
 * Move an item to another folder with everything that belongs to it: your words, highlights and
 * notes, its reading place and, for a PDF, the file. It is then deleted for good from the folder
 * it left. False if a PDF's file can't be had (not on this device, and GitHub can't be reached).
 */
export async function moveItem(from: string, to: string, id: string): Promise<boolean> {
  if (from === to) return true;
  const src = folderCtx(from).db;
  const { db, sync } = folderCtx(to);
  const item = await src.items.get(id);
  if (!item || item.purged) return false;
  const pdf = item.type === "pdf" ? await loadPdfData(from, id) : null;
  if (item.type === "pdf" && !pdf) return false;
  const marks = await src.annotations.where("doc").equals(id).toArray();
  const position = await src.positions.get(id);
  const thumb = await src.thumbs.get(id);
  const pages = await src.pageText.where("doc").equals(id).toArray();
  const now = Date.now();
  const there = await db.items.get(id);
  // Stamped as your edit, so it wins over a tombstone the other folder may hold for the same id.
  const edited = { ...item.edited };
  for (const k of [...Object.keys(item), "deleted", "purged"]) if (!BOOKKEEPING.has(k)) edited[k] = now;
  const moved: Item = { ...item, updatedAt: now, edited, path: there?.path ?? item.path };
  delete moved.deleted;
  delete moved.purged;
  await db.transaction("rw", [db.items, db.annotations, db.blobs, db.thumbs, db.pageText, db.positions], async () => {
    await db.items.put(moved);
    await db.annotations.bulkPut(marks);
    if (pdf) await db.blobs.put({ hash: id, data: new Blob([pdf], { type: "application/pdf" }), lastUsed: now });
    if (thumb) await db.thumbs.put(thumb);
    if (pages.length) await db.pageText.bulkPut(pages);
    if (position) await db.positions.put(position);
  });
  await sync.markDirty(moved.path, 500);
  if (pdf) await sync.markDirty(pdfPath(id), 0);
  const user = login();
  if (position && user) await sync.markDirty(positionsPath(user), 2_000);
  await purgeItem(from, id);
  return true;
}

/**
 * Copy a document into another folder. Folders never share notes, so only the PDF goes;
 * it is stored again in the other folder's repository.
 */
export async function copyItem(from: string, to: string, hash: string): Promise<boolean> {
  const data = await loadPdfData(from, hash);
  const meta = await folderCtx(from).db.items.get(hash);
  if (!data || !meta) return false;
  const file = new File([data], meta.fileName ?? "document.pdf", { type: "application/pdf" });
  await addPdf(to, file);
  if (meta.title) await renameItem(to, hash, meta.title);
  return true;
}

/** Load PDF bytes: from this device if cached, otherwise from the folder's repository (once). */
export async function loadPdfData(folder: string, hash: string): Promise<ArrayBuffer | null> {
  const { db, sync } = folderCtx(folder);
  const local = await db.blobs.get(hash);
  if (local) {
    void db.blobs.update(hash, { lastUsed: Date.now() });
    return local.data.arrayBuffer();
  }
  const remote = await sync.downloadPdf(hash);
  return remote ? remote.arrayBuffer() : null;
}

export async function saveAnnotation(
  folder: string,
  a: Omit<Annotation, "id" | "createdAt" | "updatedAt" | "author"> & Partial<Pick<Annotation, "id" | "createdAt">>,
) {
  const now = Date.now();
  const full: Annotation = { ...a, id: a.id ?? uid(), createdAt: a.createdAt ?? now, updatedAt: now, author: login() };
  await folderCtx(folder).db.annotations.put(full);
  await touchItem(folder, full.doc, 2_000, 8_000);
  return full;
}

export async function updateAnnotation(folder: string, id: string, patch: Partial<Annotation>) {
  const { db } = folderCtx(folder);
  const cur = await db.annotations.get(id);
  if (!cur) return;
  await db.annotations.put({ ...cur, ...patch, updatedAt: Date.now() });
  await touchItem(folder, cur.doc, 2_000, 8_000);
}

export async function deleteAnnotation(folder: string, id: string) {
  await updateAnnotation(folder, id, { deleted: true });
}

export async function savePosition(folder: string, doc: string, page: number, offset: number) {
  const { db, sync } = folderCtx(folder);
  await db.positions.put({
    doc,
    page,
    offset: Math.round(offset * 1000) / 1000,
    updatedAt: Date.now(),
    device: deviceId(),
    deviceName: deviceName(),
  });
  void noteFinished(folder, doc, page, offset);
  const user = login();
  // Position writes are frequent, so they wait longer and flush when the tab hides.
  if (user) await sync.markDirty(positionsPath(user), 15_000, 45_000);
}

/**
 * Keep local storage small: drop cached PDFs that are safely on GitHub and haven't been opened
 * recently, when the browser starts running low. Notes and highlights are never evicted.
 */
export async function evictCache(folders: string[], maxBytes = 1.5 * 1024 ** 3) {
  const est = await navigator.storage?.estimate?.();
  const quota = est?.quota ?? Infinity;
  const budget = Math.min(maxBytes, quota * 0.6);
  const rows = (
    await Promise.all(
      folders.map(async (f) => (await folderCtx(f).db.blobs.toArray()).map((r) => ({ folder: f, hash: r.hash, size: r.data.size, lastUsed: r.lastUsed }))),
    )
  )
    .flat()
    .sort((a, b) => a.lastUsed - b.lastUsed);
  let total = rows.reduce((s, r) => s + r.size, 0);
  const dayAgo = Date.now() - 86_400_000;
  for (const r of rows) {
    if (total <= budget) break;
    const { db, sync } = folderCtx(r.folder);
    if (r.lastUsed > dayAgo || !sync.isUploaded(r.hash)) continue;
    await db.blobs.delete(r.hash);
    total -= r.size;
  }
}
