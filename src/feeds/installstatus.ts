// Pure install-status logic. No Node APIs and no network, so it is easy to test.

export type InstallStatus = "missing" | "partial" | "outdated" | "current";

// Only the first line counts: both installed files start with an "engram-feeds vN" marker.
// Looking further down could match an unrelated mention in a comment.
export function installedVersion(text: string | null): number | null {
  if (text === null) return null;
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const digits = /engram-feeds v(\d+)/.exec(first)?.[1];
  return digits ? Number(digits) : null;
}

// A null version means the file is absent or has no marker. Mixed results are
// "partial" even when the rest is old, because a half-installed setup needs a full reinstall.
// A version newer than the app's own is left alone: the app must not downgrade it.
export function installStatus(
  found: { path: string; version: number | null }[],
  current: number,
): InstallStatus {
  const present = found.filter((f) => f.version !== null);
  if (present.length === 0) return "missing";
  if (present.length < found.length) return "partial";
  if (present.some((f) => (f.version as number) < current)) return "outdated";
  return "current";
}