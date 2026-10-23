// Which folder takes articles and feed entries, as a pure choice: no storage, so the tests can run it in Node.
import type { Folder } from "../model";

/** The name of the folder that takes articles and feed entries when no other has been chosen. */
export const LIBRARY_NAME = "My library";

/**
 * The library folder: the one chosen by id, else the folder named "My library", else the oldest folder.
 * The choice is pinned by id when the folder is made, so renaming it does not move the library.
 */
export function pickLibrary(folders: Folder[], chosen?: string): Folder | undefined {
  if (!folders.length) return undefined;
  return folders.find((f) => f.id === chosen) ?? folders.find((f) => f.name === LIBRARY_NAME) ?? [...folders].sort((a, b) => a.createdAt - b.createdAt)[0];
}
