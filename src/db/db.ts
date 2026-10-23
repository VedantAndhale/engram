import Dexie, { type EntityTable } from "dexie";
import type { Annotation, Folder, Item, PeerPosition, Position } from "../model";
import type { NoteRecord, ThreadRecord } from "../ai/notestate";
import type { InboxEntry } from "../sync/inboxfile";
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
/** Something an agent sent (an inbox/ file). Once you decide, sync deletes the file, then the row. */
export interface InboxRow {
  path: string;
  entry: InboxEntry;
  resolved?: "accepted" | "dismissed";
}
/** A remote path with local changes waiting to be pushed. `rev` bumps on every change. */
export interface OutboxRow {
  firstAt: number;
  path: string;
  rev: number;
  dueAt: number;
  /**
   * Failed uploads of this file in a row. A failing file waits longer each time (`dueAt`) while
   * the rest of the folder keeps syncing; a new change to it starts over.
   */
  tries?: number;
  /** Why the last upload of this file failed, shown to the reader. */
  error?: string;
  /** The file can't go to GitHub as it is (a PDF over the size limit): it isn't retried on "Sync now". */
  blocked?: boolean;
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
  inbox!: EntityTable<InboxRow, "path">;

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
    // What agents sent (inbox/ files), until you accept or dismiss it.
    this.version(4).stores({ inbox: "&path" });
  }

  async kvGet<T>(key: string): Promise<T | undefined> {
    return (await this.kv.get(key))?.value as T | undefined;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.kv.put({ key, value });
  }
}

export const folderDbName = (folderId: string) => `reader-folder-${folderId}`;

/** App-wide data: the folder list, and the AI notes kept on this device (see ai/notestate.ts). */
class AppDB extends Dexie {
  folders!: EntityTable<Folder, "id">;
  aiNotes!: EntityTable<NoteRecord, "id">;
  aiThreads!: EntityTable<ThreadRecord, "key">;

  constructor() {
    super("reader-app");
    this.version(1).stores({ folders: "&id, createdAt" });
    this.version(2).stores({ aiNotes: "&id, item", aiThreads: "&key" });
  }
}

export const appDb = new AppDB();
