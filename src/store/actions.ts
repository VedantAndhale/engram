import { folderCtx } from "../folders/registry";
import { extractText, inspectPdf, openPdf } from "../lib/pdf";
import { deviceId, deviceName, sha256Hex, uid } from "../lib/util";
import type { Annotation, Item } from "../model";
import { getAccount } from "../sync/account";
import { itemPath, pdfPath, positionsPath } from "../sync/paths";

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

async function updateItem(folder: string, id: string, patch: Partial<Item>, delayMs = 1500) {
  await folderCtx(folder).db.items.update(id, { ...patch, updatedAt: Date.now() });
  await touchItem(folder, id, delayMs);
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
  const { title, pages, thumb } = await inspectPdf(data, file.name);
  const now = Date.now();
  const addedAt = existing?.addedAt ?? now;
  const item: Item = {
    ...existing,
    id: hash,
    type: "pdf",
    title: existing?.title ?? title,
    fileName: file.name,
    size: file.size,
    pages,
    addedAt,
    addedBy: login(),
    updatedAt: now,
    deleted: undefined,
    path: existing?.path ?? itemPath(hash, existing?.title ?? title, addedAt),
  };
  await db.transaction("rw", [db.items, db.blobs, db.thumbs], async () => {
    await db.items.put(item);
    await db.blobs.put({ hash, data: new Blob([data], { type: "application/pdf" }), lastUsed: now });
    await db.thumbs.put({ hash, dataUrl: thumb });
  });
  await sync.markDirty(pdfPath(hash), 0);
  await sync.markDirty(item.path, 500);
  void indexDocument(folder, hash, data);
  return hash;
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
