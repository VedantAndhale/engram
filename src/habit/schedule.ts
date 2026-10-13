/*
 * The review schedule, kept free of the database so it can be tested on its own.
 * A Leitner-style ladder: "still clear" moves a highlight one step further out, "hazy" brings it
 * back tomorrow. Past the last fixed step the gap keeps growing, and a highlight can be retired.
 */

export const DAY = 86_400_000;
/** Days until a highlight comes back, by step. */
export const INTERVALS = [1, 3, 7, 16, 35, 90];
/** Past the last step, each "still clear" multiplies the gap by this. */
export const GROWTH = 2.5;
/** The longest gap: about ten years. */
const MAX_DAYS = 3650;
/** How many highlights a day brings at most. The rest wait for the following days, oldest first. */
export const DAILY_CAP = 30;
/** A retired highlight's due date: far off, but still a real date (it is written to the folder index). */
const RETIRED_FOR = 100 * 365 * DAY;

/** The same shape as the model's Review, plus whether the reader asked not to see it again. */
export interface Schedule {
  step: number;
  due: number;
  last: number;
  count: number;
  /** "Don't show again": never due. Kept on the annotation, so it syncs like any review. */
  retired?: boolean;
}

/** The gap after reaching `step`, in days. */
export function intervalDays(step: number): number {
  if (step < INTERVALS.length) return INTERVALS[Math.max(0, step)];
  const days = INTERVALS[INTERVALS.length - 1] * GROWTH ** (step - INTERVALS.length + 1);
  return Math.min(Math.round(days), MAX_DAYS);
}

/** A small, repeatable nudge (within ±10%) so highlights saved together don't all come back on one day. */
function jitter(key: string, count: number): number {
  let h = 2166136261;
  for (const c of `${key}|${count}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) / 0xffffffff) * 0.2 - 0.1;
}

/** The next schedule after a review. `key` keeps the nudge the same for the same card and review. */
export function nextReview(prev: Schedule | undefined, clear: boolean, now: number, key = ""): Schedule {
  const count = (prev?.count ?? 0) + 1;
  const step = clear ? (prev?.step ?? 0) + 1 : 0;
  const base = intervalDays(step);
  // Short gaps stay exact: tomorrow means tomorrow.
  const days = base >= 7 ? Math.max(1, Math.round(base * (1 + jitter(key, count)))) : base;
  return { step, due: now + days * DAY, last: now, count };
}

/** "Don't show again". */
export function retireReview(prev: Schedule | undefined, now: number): Schedule {
  return { step: prev?.step ?? 0, due: now + RETIRED_FOR, last: now, count: prev?.count ?? 0, retired: true };
}

export const isRetired = (r: Partial<Schedule> | undefined) => !!r?.retired;

/** Local midnight at the start of `now`'s day. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Schedulable {
  due: number;
  review?: Pick<Schedule, "last" | "retired">;
}

/**
 * Today's share of what's due: oldest due first, at most `cap` a day counting what was already
 * reviewed today. A backlog doesn't arrive all at once; it comes in over the following days.
 */
export function todaysShare<T extends Schedulable>(cards: T[], now: number, cap = DAILY_CAP): { today: T[]; waiting: number } {
  const dayStart = startOfDay(now);
  const done = cards.filter((c) => (c.review?.last ?? 0) >= dayStart).length;
  const due = cards.filter((c) => c.due <= now && !isRetired(c.review)).sort((a, b) => a.due - b.due);
  const room = Math.max(0, cap - done);
  return { today: due.slice(0, room), waiting: Math.max(0, due.length - room) };
}
