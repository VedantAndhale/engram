// Splits ready files into commits. Pure, so the limits can be tested in Node.

/** Most files one batch commit carries. A 250-file tree was stored in the write probe, so 200 leaves room. */
export const BATCH_MAX_FILES = 200;
/** Most text one batch commit carries. The probe stored 25 MB in one tree; 20 MB keeps a margin. */
export const BATCH_MAX_BYTES = 20 * 1024 * 1024;

/** A batch commit's message: one line with the count, then the first ten changes, each on its own line. */
export function batchMessage(lines: string[]): string {
  const count = lines.length;
  const names = lines.slice(0, 10).map((line) => `- ${line}`);
  const more = count > 10 ? [`and ${count - 10} more`] : [];
  return [`Sync ${count} change${count === 1 ? "" : "s"}`, "", ...names, ...more].join("\n");
}

/**
 * Groups items, in order, so each group holds at most `maxFiles` items and `maxBytes` bytes. An item larger than
 * `maxBytes` still goes through, alone in its own group.
 */
export function planBatches<T extends { bytes: number }>(
  items: T[],
  maxFiles = BATCH_MAX_FILES,
  maxBytes = BATCH_MAX_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const full = current.length >= maxFiles || (current.length > 0 && bytes + item.bytes > maxBytes);
    if (full) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
