// What the feeds Action last recorded for one feed, read for display. Browser-safe: no Node APIs here.
export type FeedRunState = {
  retryAfter?: string | null;
  lastError?: { message?: string; since?: string } | null;
};

export type FeedStatus =
  | { kind: "new" }
  | { kind: "waiting" }
  | { kind: "due" }
  | { kind: "paused"; until: string }
  | { kind: "failing"; message: string; since: string | null }
  | { kind: "working" };

// The Action records this when a run ends before it reaches a feed. The feed did not fail; it is simply next in line.
export const DEADLINE_MESSAGE = "deadline";

/** How a feed is doing, from the Action's state. `now` is passed in so the result can be tested. */
export function feedStatus(run: FeedRunState | undefined, now: number): FeedStatus {
  if (!run) return { kind: "new" };
  const err = run.lastError;
  if (err?.message === DEADLINE_MESSAGE) return { kind: "waiting" };
  const until = run.retryAfter ? Date.parse(run.retryAfter) : NaN;
  if (Number.isFinite(until)) {
    if (until > now) return { kind: "paused", until: run.retryAfter as string };
    // The wait is over but the last try failed, so the next run tries again.
    if (err?.message) return { kind: "due" };
  }
  if (err?.message) return { kind: "failing", message: err.message, since: err.since || null };
  return { kind: "working" };
}

// Problems first, so a broken feed is not hidden at the bottom of a long list.
const ORDER: Record<FeedStatus["kind"], number> = { failing: 0, paused: 1, due: 2, waiting: 3, new: 4, working: 5 };

export function statusRank(status: FeedStatus): number {
  return ORDER[status.kind];
}
