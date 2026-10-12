/*
 * Where a playlist entry lands when it moves one place. Each entry has a number, and it takes a number between
 * its new neighbours, so the list never has to be renumbered. Two devices moving different entries therefore
 * each write only their own entry, and both changes survive the merge.
 */

/** The order an entry takes when it moves up (-1) or down (+1) past its neighbour. Null when it can't move that way. */
export function orderAfterMove(orders: number[], i: number, dir: -1 | 1): number | null {
  const j = i + dir;
  if (i < 0 || i >= orders.length || j < 0 || j >= orders.length) return null;
  const passed = orders[j];
  if (dir < 0) {
    const above = j - 1 >= 0 ? orders[j - 1] : undefined;
    return above === undefined ? passed - 1 : (above + passed) / 2;
  }
  const below = j + 1 < orders.length ? orders[j + 1] : undefined;
  return below === undefined ? passed + 1 : (passed + below) / 2;
}
