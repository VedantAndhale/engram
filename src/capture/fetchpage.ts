import { folderCtx } from "../folders/registry";
import type { Item, ItemType } from "../model";
import { fillItem, updateItem } from "../store/actions";
import { pickUntried, markTried } from "./backlog";
import { cleanMarkdown, missingDetails, READABLE, titleFromUrl, typeForUrl } from "./capture";
import { extractArticle, imageUrl, shrinks, type Extracted } from "./extract";

/*
 * Filling in articles from the web. Links saved from a phone or by pasting arrive with no text,
 * and articles saved before Engram kept formatting are plain text. Either way the page is
 * fetched through Engram's server (browsers can't read other sites directly) and the article is
 * picked out here, on the device. Failures are quiet: the item simply stays as it was.
 */

/** The article at a URL, through /api/page. Null if it can't be fetched or has no article. */
export async function fetchArticle(url: string): Promise<Extracted | null> {
  try {
    const res = await fetch(`/api/page?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    return await extractArticle(await res.text(), res.headers.get("X-Final-Url") ?? url);
  } catch {
    return null;
  }
}

const tried = new Set<string>();

/**
 * Fetch an item's page and keep the article: fills in a bare link, or upgrades plain text to the
 * formatted version. Each item is tried at most once per session.
 */
export async function fillFromWeb(folder: string, id: string): Promise<boolean> {
  const { db } = folderCtx(folder);
  const item = await db.items.get(id);
  if (!item?.sourceUrl || item.deleted || item.contentFormat === "markdown" || !READABLE.includes(item.type)) return false;
  if (tried.has(id)) return false;
  tried.add(id);
  const got = await fetchArticle(item.sourceUrl);
  const markdown = got && cleanMarkdown(got.markdown);
  // A page that couldn't be fetched may work next time, so it isn't counted as tried.
  if (!got) {
    tried.delete(id);
    return false;
  }
  if (!markdown) return false;
  const now = await db.items.get(id);
  if (!now || now.deleted || now.contentFormat === "markdown") return false;
  const patch: Partial<Item> = missingDetails(now, got);
  // A page behind a login or paywall comes back as something much shorter than what the
  // bookmarklet saw; keep the fuller plain text then. The details still fill in.
  if (!shrinks(markdown, now.content)) {
    patch.content = markdown;
    patch.contentFormat = "markdown";
    if (got.title && now.title === titleFromUrl(now.sourceUrl!)) patch.title = got.title.slice(0, 300);
    if (now.type === "bookmark") patch.type = typeForUrl(now.sourceUrl!, markdown.length);
  }
  if (!Object.keys(patch).length) return false;
  await updateItem(folder, id, patch, 500);
  return true;
}

const PICTURE_TRIED = "reader.pictureTried";
/** Kinds of item whose page can carry a picture: links, articles and posts, tweets included. */
const PICTURED: ItemType[] = [...READABLE, "tweet"];

/**
 * Give saved links, articles and tweets their page's picture when they have none. A few are tried each time a
 * library opens, the ones tried longest ago first (see backlog.ts), so a page that won't load doesn't hold up the rest.
 */
export async function backfillPictures(folder: string, limit = 25): Promise<void> {
  const { db } = folderCtx(folder);
  const candidates = (await db.items.toArray()).filter((i) => !i.image && !i.deleted && i.sourceUrl && PICTURED.includes(i.type)).map((i) => i.id);
  for (const id of pickUntried(PICTURE_TRIED, candidates, limit)) {
    const item = await db.items.get(id);
    if (!item?.sourceUrl) continue;
    markTried(PICTURE_TRIED, id);
    try {
      const res = await fetch(`/api/page?url=${encodeURIComponent(item.sourceUrl)}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const image = imageUrl(doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content"), item.sourceUrl);
      if (image) await fillItem(folder, id, { image });
    } catch {
      // Tried already; it is tried again after a week.
    }
  }
}
