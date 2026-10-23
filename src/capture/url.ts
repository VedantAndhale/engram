import type { ItemType } from "../model";
import { watchUrl, youtubeId } from "../video/youtube.js";

/*
 * Addresses: the form a link is kept in, and what kind of page it points to. Pure (no storage, no
 * DOM), so the MCP server applies the same rules as the app.
 */

/** Drop tracking parameters and the fragment, so the same page saved twice is one item. */
export function cleanUrl(url: string): string {
  // One YouTube video is one address, however it was copied: a timestamp, a playlist or a short link is the same video.
  const video = youtubeId(url);
  if (video) return watchUrl(video);
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|igshid$|ref_src$|si$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.href;
  } catch {
    return url;
  }
}

/** Guess an item's type from its address. */
export function typeForUrl(url: string, contentLength = 0): ItemType {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "bookmark";
  }
  const host = u.hostname.replace(/^(www|mobile|m)\./, "");
  const path = u.pathname;
  if ((host === "x.com" || host === "twitter.com") && /\/status\/\d+/.test(path)) return "tweet";
  if (host === "youtube.com" || host === "youtu.be" || host === "vimeo.com" || host === "tiktok.com") return "video";
  if (/\.pdf$/i.test(path)) return "bookmark";
  if (
    host === "reddit.com" ||
    host === "threads.net" ||
    host === "bsky.app" ||
    host === "news.ycombinator.com" ||
    (host === "linkedin.com" && /^\/(posts|feed)\//.test(path))
  )
    return "post";
  return contentLength > 1500 ? "article" : "bookmark";
}
