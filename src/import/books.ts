import { createItem, saveAnnotation } from "../store/actions";
import { folderCtx } from "../folders/registry";
import { HIGHLIGHT_COLORS } from "../model";
import { refId } from "./hash";
import { importRef } from "./ref";
import type { ImportBook } from "./types";

export interface ImportResult {
  books: number;
  created: number;
  highlights: number;
  alreadyThere: number;
  failed: number;
}

export async function importBooks(
  folder: string,
  books: ImportBook[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { books: 0, created: 0, highlights: 0, alreadyThere: 0, failed: 0 };
  let done = 0;

  // One book at a time: a bad book is counted and skipped, never allowed to stall the rest.
  for (const book of books) {
    result.books++;
    try {
      const ref = await importRef(book);
      const { db } = folderCtx(folder);

      // A book already imported is never created or revived, even if it was trashed or purged.
      // Its highlights are still checked, because a later export may add new ones.
      const existing = await db.items.filter((i) => i.importRef === ref).first();
      let itemId: string;
      if (existing) {
        itemId = existing.id;
      } else {
        const item = await createItem(folder, {
          type: "book",
          title: book.title,
          source: book.author || undefined,
          importRef: ref,
          body: book.notes.length ? book.notes.join("\n\n") : undefined,
        });
        itemId = item.id;
        result.created++;
      }

      for (const h of book.highlights) {
        // A fixed id per highlight makes a re-import a no-op and keeps the reader's own edits.
        const id = `imp-${await refId(`${ref}|${h.quote}`)}`;
        if (await db.annotations.get(id)) {
          result.alreadyThere++;
          continue;
        }
        await saveAnnotation(folder, {
          id,
          doc: itemId,
          kind: "highlight",
          page: 0,
          quote: h.quote,
          note: h.note,
          color: HIGHLIGHT_COLORS[0].value,
        });
        result.highlights++;
      }
    } catch {
      result.failed++;
    }
    done++;
    onProgress?.(done, books.length);
  }

  return result;
}