import { folderCtx } from "../folders/registry";
import { updateItem } from "../store/actions";
import { needsTitle, watchUrl, youtubeId } from "./youtube";

/*
 * A saved YouTube video's real title. A link saved by pasting, sharing or quick add arrives with
 * only its address, so its title is asked of YouTube's oEmbed, which any site may call.
 */

const MAX_TITLE = 300;

/** The title YouTube gives a video, or null when it can't be had (offline, removed or private). */
export async function videoTitle(id: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(id))}&format=json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const { title } = (await res.json()) as { title?: unknown };
    return typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || null : null;
  } catch {
    return null;
  }
}

const tried = new Set<string>();

/** Give a saved YouTube video its real title, unless it has one already. Tried once per item per session. */
export async function fillVideoTitle(folder: string, itemId: string): Promise<void> {
  const key = `${folder}/${itemId}`;
  if (tried.has(key)) return;
  tried.add(key);
  const { db } = folderCtx(folder);
  const item = await db.items.get(itemId);
  const id = youtubeId(item?.sourceUrl ?? "");
  if (!item || item.deleted || item.type !== "video" || !id || !needsTitle(item.title)) return;
  const title = await videoTitle(id);
  // Renamed while YouTube was asked: the reader's name stays.
  const now = await db.items.get(itemId);
  if (title && now && !now.deleted && needsTitle(now.title)) await updateItem(folder, itemId, { title }, 500);
}
