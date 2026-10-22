/** Room between notes in the margin. */
export const GAP = 12;

/** Where each note starts from the top of the column when `desired` is where its passage is. */
export function settle(items: { id: string; desired: number; h: number }[], activeId: string | null): Record<string, number> {
  const tops = items.map((i) => i.desired);
  // Push each note below the one above it.
  const down = (from: number) => {
    for (let i = Math.max(1, from); i < items.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].h + GAP);
  };
  const open = activeId ? items.findIndex((i) => i.id === activeId) : -1;
  if (open < 0) {
    tops[0] = Math.max(0, tops[0] ?? 0);
    down(1);
  } else {
    // The open note stays beside its passage; the others make way, above and below it.
    down(open + 1);
    for (let i = open - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - GAP - items[i].h);
    if (tops[0] < 0) {
      tops[0] = 0;
      down(1);
    }
  }
  return Object.fromEntries(items.map((it, i) => [it.id, tops[i]]));
}
