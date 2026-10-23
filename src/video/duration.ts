/*
 * How long a video is, in seconds. YouTube's watch page says it, read through Engram's server (see
 * capture/fetchpage.ts). Saved on the video's item, so a playlist can show its total time.
 */

import { folderCtx } from "../folders/registry";
import { markTried, pickUntried } from "../capture/backlog";
import { fillItem } from "../store/actions";
import { watchUrl, youtubeId } from "./youtube";

const LENGTH_TRIED = "reader.lengthTried";

/** A YouTube video's length in seconds, or undefined when its page doesn't say. */
export async function lengthOf(id: string): Promise<number | undefined> {
  try {
    const res = await fetch(`/api/page?url=${encodeURIComponent(watchUrl(id))}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const seconds = Number(/"lengthSeconds":"(\d+)"/.exec(await res.text())?.[1]);
    return seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** Save a video item's length, when it has none yet. A page that can't be read is tried again later. */
export async function fillDuration(folder: string, itemId: string): Promise<void> {
  const { db } = folderCtx(folder);
  const item = await db.items.get(itemId);
  const id = youtubeId(item?.sourceUrl ?? "");
  if (!item || item.duration || !id) return;
  const duration = await lengthOf(id);
  if (duration) await fillItem(folder, itemId, { duration });
}

/** Lengths for the videos in playlists that don't have one yet: a few each time a library opens, the longest untried first. */
export async function backfillDurations(folder: string, limit = 20): Promise<void> {
  const { db } = folderCtx(folder);
  const entries = await db.annotations.filter((a) => a.kind === "entry" && !a.deleted && !!a.ref).toArray();
  const videos = await Promise.all([...new Set(entries.map((a) => a.ref!))].map((ref) => db.items.get(ref)));
  const missing = videos.filter((v) => v && !v.deleted && !v.duration).map((v) => v!.id);
  for (const id of pickUntried(LENGTH_TRIED, missing, limit)) {
    const item = await db.items.get(id);
    const videoId = youtubeId(item?.sourceUrl ?? "");
    if (!item || !videoId) continue;
    markTried(LENGTH_TRIED, id);
    const duration = await lengthOf(videoId);
    if (duration) await fillItem(folder, id, { duration });
  }
}

/** A length as the library shows it: "1 h 5 min", "45 min", or "40 s" under a minute. */
export function formatLength(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
