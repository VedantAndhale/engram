import Dexie, { type EntityTable } from "dexie";
import type { Annotation, Folder, Item, PeerPosition, Position } from "../model";
import { itemPath } from "../sync/paths";

export interface BlobRow {
  hash: string;
  data: Blob;
  lastUsed: number;
}
export interface ThumbRow {
  hash: string;
  dataUrl: string;
}
export interface PageTextRow {
  doc: string;
  page: number;
  text: string;
}
export interface KvRow {
  key: string;
  value: unknown;
}
/** A remote path with local changes waiting to be pushed. `rev` bumps on every change. */
export interface OutboxRow {
  firstAt: number;
  path: string;
  rev: number;
  dueAt: number;
}

/**
 * One database per folder, mirroring that folder's repository. The local database is the
 * source of truth for the UI: every edit lands here first, then the folder's sync engine
 * moves it to GitHub. Keeping folders apart means the same PDF can sit in two folders
 * (or two people's repos) without their notes ever mixing.
 */
export class ReaderDB extends Dexie {
  items!: EntityTable<Item, "id">;
  blobs!: EntityTable<BlobRow, "hash">;
  thumbs!: EntityTable<ThumbRow, "hash">;
  annotations!: EntityTable<Annotation, "id">;
  positions!: EntityTable<Position, "doc">;
  peers!: EntityTable<PeerPosition, "key">;
  pageText!: Dexie.Table<PageTextRow, [string, number]>;
  kv!: EntityTable<KvRow, "key">;
  outbox!: EntityTable<OutboxRow, "path">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      docs: "&hash, updatedAt",
      blobs: "&hash, lastUsed",
      thumbs: "&hash",
      annotations: "&id, doc, updatedAt",
      positions: "&doc, updatedAt",
      peers: "&key, doc, user",
      pageText: "&[doc+page], doc",
      kv: "&key",
      outbox: "&path, dueAt",
    });
    // Documents become items of any type, each with its own file in the repository.
    this.version(2)
      .stores({ items: "&id, updatedAt, path" })
      .upgrade(async (tx) => {
        const docs = await tx.table("docs").toArray();
        await tx.table("items").bulkPut(
          docs.map(({ hash, ...d }) => ({ id: hash, type: "pdf", ...d, path: itemPath(hash, d.title, d.addedAt) })),
        );
      });
    this.version(3).stores({ docs: null });
  }

  async kvGet<T>(key: string): Promise<T | undefined> {
    return (await this.kv.get(key))?.value as T | undefined;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.kv.put({ key, value });
  }
}

export const folderDbName = (folderId: string) => `reader-folder-${folderId}`;

/** App-wide data: the folder list. */
class AppDB extends Dexie {
  folders!: EntityTable<Folder, "id">;

  constructor() {
    super("reader-app");
    this.version(1).stores({ folders: "&id, createdAt" });
  }
}

export const appDb = new AppDB();
