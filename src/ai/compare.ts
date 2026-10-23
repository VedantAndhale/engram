/*
 * The passage kept for a comparison. The next passage selected in the same item is compared with it.
 * It is held in memory only: it clears on reload, as threads do, and it is never offered for another item.
 */
import { create } from "zustand";

export interface KeptPassage {
  /** The item it was selected in. A comparison stays within one item. */
  item: string;
  text: string;
}

export const useKept = create<{ kept: KeptPassage | null }>(() => ({ kept: null }));

export const keepPassage = (item: string, text: string) => useKept.setState({ kept: { item, text } });
export const clearKept = () => useKept.setState({ kept: null });

/** The kept passage's text when it was kept in `item`, else null. A passage kept in another item is not offered. */
export function keptIn(kept: KeptPassage | null, item: string): string | null {
  return kept && kept.item === item ? kept.text : null;
}
