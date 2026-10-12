import { folderCtx } from "../folders/registry";
import type { Item } from "../model";
import { updateItem } from "../store/actions";
import { cleanMarkdown, missingDetails, READABLE, titleFromUrl, typeForUrl } from "./capture";
import { extractArticle, type Extracted } from "./extract";

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
  if (!got || !markdown) return false;
  const now = await db.items.get(id);
  if (!now || now.deleted || now.contentFormat === "markdown") return false;
  const patch: Partial<Item> = missingDetails(now, got);
  // A page behind a login or paywall comes back as something much shorter than what the
  // bookmarklet saw; keep the fuller plain text then. The details still fill in.
  const plainLength = now.content?.replace(/\s/g, "").length ?? 0;
  if (plainLength === 0 || markdown.replace(/[\s*_#>`[\]()\\-]/g, "").length >= plainLength * 0.6) {
    patch.content = markdown;
    patch.contentFormat = "markdown";
    if (got.title && now.title === titleFromUrl(now.sourceUrl!)) patch.title = got.title.slice(0, 300);
    if (now.type === "bookmark") patch.type = typeForUrl(now.sourceUrl!, markdown.length);
  }
  if (!Object.keys(patch).length) return false;
  await updateItem(folder, id, patch, 500);
  return true;
}
