import { setHabit, useHabit } from "../habit/prefs";
import type { Folder } from "../model";
import { pickLibrary } from "./pick";

export { LIBRARY_NAME } from "./pick";

/**
 * The folder articles, blogs and feed entries go to, for this device. The choice is kept per device and is
 * read live from the habit settings. See pickLibrary for the rule.
 */
export function libraryOf(folders: Folder[] | undefined, chosen = useHabit.getState().libraryId): Folder | undefined {
  return folders ? pickLibrary(folders, chosen) : undefined;
}

/** Make a folder the library on this device. */
export function chooseLibrary(id: string) {
  setHabit({ libraryId: id });
}
