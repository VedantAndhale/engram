import type { Annotation, Item } from "../model.js";

/*
 * Three-way merging of one item and its annotations: the version both sides last agreed on
 * (the base, what the repository held when this device last synced the file), this device's
 * version and the repository's. Each field is settled on its own, so two devices changing
 * different fields both keep their change:
 *
 *   - a field only one side changed takes that side's value;
 *   - the item's own words (body) and highlight notes are merged line by line; lines both
 *     sides changed differently are kept twice, between conflict markers, never dropped;
 *   - topics are merged as a set: additions and removals from both sides apply;
 *   - any other field both sides changed goes to the side that edited it last by hand
 *     (`Item.edited`); background updates such as an article fill-in never set that stamp,
 *     so they never win over your own edit. Ties fall back to updatedAt.
 *
 * Without a base (an item first seen on both sides at once, or a base that couldn't be read)
 * fields fall back to "newer wins", and text is kept from both sides unless one contains the other.
 *
 * Pure functions, no database: the sync engine and the tests both use them. New fields need
 * nothing here: they merge like any other field.
 */

/** Opens a block of lines that two devices changed differently. */
export const CONFLICT_START = "<<<<<<< Edited in two places at once: both versions are kept below. Keep what you want and delete the rest.";
export const CONFLICT_SPLIT = "=======";
export const CONFLICT_END = ">>>>>>> End of the two versions";

/** Fields that are bookkeeping, not content: never merged as values. */
const ITEM_SKIP = new Set(["id", "path", "updatedAt", "edited"]);
const ANNOTATION_SKIP = new Set(["id", "doc", "updatedAt"]);
const ITEM_TEXT = new Set(["body"]);
const ANNOTATION_TEXT = new Set(["note"]);
const ITEM_SETS = new Set(["topics"]);

/** Empty values mean "not set" everywhere in the file format, so they compare equal. */
function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === "" || v === false) return undefined;
  if (Array.isArray(v) && v.length === 0) return undefined;
  return v;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object)
      .filter((k) => norm((v as Record<string, unknown>)[k]) !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(norm(v)) ?? "null";
}

export const sameValue = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** True if two records hold the same content, ignoring the fields in `skip`. */
export function sameRecord(a: object, b: object, skip: ReadonlySet<string> = new Set()): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (!skip.has(k) && !sameValue(ra[k], rb[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** Longest-common-subsequence cells allowed before a changed middle is treated as one block. */
const MAX_LCS_CELLS = 4_000_000;

/** For each line of `a`, the line of `b` it matches in a longest common subsequence, or -1. */
function matchLines(a: string[], b: string[]): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    match[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) return match;
  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j;
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  return match;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
const startsWith = (a: string[], prefix: string[]) => prefix.length <= a.length && prefix.every((l, i) => l === a[i]);

/** One stretch both sides changed: take the side that changed, or keep both. */
function resolveChunk(base: string[], local: string[], remote: string[]): string[] {
  if (sameLines(local, base)) return remote;
  if (sameLines(remote, base) || sameLines(local, remote)) return local;
  if (base.length === 0) {
    // Both only added lines here (two devices appending to the same note): keep both, no markers.
    if (startsWith(remote, local)) return remote;
    if (startsWith(local, remote)) return local;
    return [...local, ...remote];
  }
  return [CONFLICT_START, ...local, CONFLICT_SPLIT, ...remote, CONFLICT_END];
}

/** Line-based three-way merge (diff3). Never drops a line either side wrote. */
function mergeLines(base: string[], local: string[], remote: string[]): string[] {
  const ml = matchLines(base, local);
  const mr = matchLines(base, remote);
  const out: string[] = [];
  let i = 0;
  let il = 0;
  let ir = 0;
  while (i < base.length || il < local.length || ir < remote.length) {
    // The next base line both sides kept, at or after where we are.
    let j = i;
    while (j < base.length && (ml[j] < il || mr[j] < ir)) j++;
    const endL = j < base.length ? ml[j] : local.length;
    const endR = j < base.length ? mr[j] : remote.length;
    if (j === i && endL === il && endR === ir) {
      out.push(base[i]);
      i++;
      il++;
      ir++;
      continue;
    }
    out.push(...resolveChunk(base.slice(i, j), local.slice(il, endL), remote.slice(ir, endR)));
    i = j;
    il = endL;
    ir = endR;
  }
  return out;
}

/**
 * Merge a text field. `base` undefined means there is no common version to compare with: then
 * text one side holds entirely wins, and otherwise both are kept between conflict markers.
 */
export function mergeText(
  base: string | undefined,
  local: string | undefined,
  remote: string | undefined,
  hasBase = base !== undefined,
): string | undefined {
  const l = local ?? "";
  const r = remote ?? "";
  if (l === r) return local;
  if (!hasBase) {
    if (!l.trim()) return remote;
    if (!r.trim() || l.includes(r)) return local;
    if (r.includes(l)) return remote;
    return [CONFLICT_START, l, CONFLICT_SPLIT, r, CONFLICT_END].join("\n");
  }
  const b = base ?? "";
  if (l === b) return remote;
  if (r === b) return local;
  const split = (s: string) => (s === "" ? [] : s.split("\n"));
  const merged = mergeLines(split(b), split(l), split(r)).join("\n");
  return merged === "" ? undefined : merged;
}

/** Set merge in local order, then remote additions: what either side added or removed applies. */
function mergeSet(base: unknown, local: unknown, remote: unknown, hasBase: boolean): string[] | undefined {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []);
  const b = new Set(list(base));
  const l = list(local);
  const r = list(remote);
  const removed = hasBase ? new Set([...b].filter((t) => !l.includes(t) || !r.includes(t))) : new Set<string>();
  const out = [...new Set([...l, ...r])].filter((t) => !removed.has(t));
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

interface RecordRules<T> {
  skip: ReadonlySet<string>;
  text: ReadonlySet<string>;
  sets?: ReadonlySet<string>;
  /** When this side last changed `field` by hand; 0 if unknown. */
  stamp?: (t: T, field: string) => number;
}

/** Deterministic "newer wins", so every device settles a true conflict the same way. */
function newerSide<T extends { updatedAt: number }>(local: T, remote: T, field: string, rules: RecordRules<T>): "local" | "remote" {
  const sl = rules.stamp?.(local, field) ?? 0;
  const sr = rules.stamp?.(remote, field) ?? 0;
  if (sl !== sr) return sl > sr ? "local" : "remote";
  if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt ? "local" : "remote";
  const vl = stableJson((local as Record<string, unknown>)[field]);
  const vr = stableJson((remote as Record<string, unknown>)[field]);
  return vl >= vr ? "local" : "remote";
}

function mergeRecord<T extends { updatedAt: number }>(base: T | undefined, local: T, remote: T, rules: RecordRules<T>): T {
  const out = { ...local } as Record<string, unknown>;
  const b = base as Record<string, unknown> | undefined;
  const l = local as Record<string, unknown>;
  const r = remote as Record<string, unknown>;
  const keys = new Set([...Object.keys(l), ...Object.keys(r), ...(b ? Object.keys(b) : [])]);
  for (const k of keys) {
    if (rules.skip.has(k) || sameValue(l[k], r[k])) continue;
    let v: unknown;
    if (b && sameValue(l[k], b[k])) v = r[k];
    else if (b && sameValue(r[k], b[k])) continue;
    else if (rules.text.has(k)) v = mergeText(b?.[k] as string | undefined, l[k] as string | undefined, r[k] as string | undefined, !!b);
    else if (rules.sets?.has(k)) v = mergeSet(b?.[k], l[k], r[k], !!b);
    else v = newerSide(local, remote, k, rules) === "local" ? l[k] : r[k];
    if (norm(v) === undefined) delete out[k];
    else out[k] = v;
  }
  out.updatedAt = Math.max(local.updatedAt, remote.updatedAt);
  return out as T;
}

const itemRules: RecordRules<Item> = {
  skip: ITEM_SKIP,
  text: ITEM_TEXT,
  sets: ITEM_SETS,
  stamp: (i, field) => i.edited?.[field] ?? 0,
};

const annotationRules: RecordRules<Annotation> = { skip: ANNOTATION_SKIP, text: ANNOTATION_TEXT };

/** Merge one item's fields. `local.path` is kept. */
export function mergeItem(base: Item | undefined, local: Item, remote: Item): Item {
  const out = mergeRecord(base, local, remote, itemRules);
  const edited: Record<string, number> = { ...remote.edited };
  for (const [k, t] of Object.entries(local.edited ?? {})) edited[k] = Math.max(t, edited[k] ?? 0);
  if (Object.keys(edited).length) out.edited = edited;
  else delete out.edited;
  return out;
}

export function mergeAnnotation(base: Annotation | undefined, local: Annotation, remote: Annotation): Annotation {
  return mergeRecord(base, local, remote, annotationRules);
}

/** True if `a` and `b` hold the same item content (the path is the device's own business). */
export const sameItem = (a: Item, b: Item) => sameRecord(a, b, new Set(["path"]));
export const sameAnnotation = (a: Annotation, b: Annotation) => sameRecord(a, b);

export interface AnnotationMerge {
  /** Records to write locally. */
  put: Annotation[];
  /** This device has something the remote file lacks. */
  localAhead: boolean;
}

/**
 * Merge an item's annotations. Annotations are never removed from a file by the app (deletions
 * are tombstones), so one missing on either side is simply new there.
 */
export function mergeAnnotations(base: Annotation[] | undefined, local: Annotation[], remote: Annotation[]): AnnotationMerge {
  const baseMap = new Map((base ?? []).map((a) => [a.id, a]));
  const localMap = new Map(local.map((a) => [a.id, a]));
  const remoteIds = new Set(remote.map((a) => a.id));
  const put: Annotation[] = [];
  let localAhead = local.some((a) => !remoteIds.has(a.id));
  for (const r of remote) {
    const l = localMap.get(r.id);
    if (!l) {
      put.push(r);
      continue;
    }
    if (sameAnnotation(l, r)) continue;
    const m = mergeAnnotation(baseMap.get(r.id), l, r);
    if (!sameAnnotation(m, l)) put.push(m);
    if (!sameAnnotation(m, r)) localAhead = true;
  }
  return { put, localAhead };
}
