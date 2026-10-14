// Pure, so the tests can use it without the app's storage.
import { refId } from "./hash";
import type { ImportBook } from "./types";

// // The ref is derived from the file's own key, so importing the same file twice finds the same item.
export async function importRef(book: ImportBook): Promise<string> {
  return `${book.source}:${await refId(book.key)}`;
}
