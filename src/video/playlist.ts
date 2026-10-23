/*
 * A YouTube playlist link, and the videos and name on its page. The page is fetched through Engram's
 * server (see capture/fetchpage.ts). YouTube shows only the first part of a long playlist on its page,
 * so a very long one is partly saved.
 */

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

/** The playlist id in a YouTube playlist link, or null. A watch link with a list is still a video. */
export function playlistIdOf(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (!HOSTS.has(u.hostname.toLowerCase()) || u.pathname !== "/playlist") return null;
  const list = u.searchParams.get("list");
  return list && /^[A-Za-z0-9_-]+$/.test(list) ? list : null;
}

/** The address of a playlist's page. */
export const playlistUrl = (id: string) => `https://www.youtube.com/playlist?list=${id}`;

/**
 * The video ids of a playlist, in the order its page numbers them. Each entry on the page carries the
 * playlist's id and its place in the list; entries of other playlists (suggestions) are left out.
 */
export function playlistVideoIds(html: string, list: string): string[] {
  const entries = new Map<number, string>();
  for (const m of html.matchAll(/"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{11})","playlistId":"([A-Za-z0-9_-]+)","index":(\d+)/g)) {
    if (m[2] === list && !entries.has(+m[3])) entries.set(+m[3], m[1]);
  }
  return [...entries].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

/** The playlist's name from its page's title tag, with HTML escapes undone. Undefined when there is none. */
export function playlistName(html: string): string | undefined {
  const raw = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const name = raw
    ?.replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return name || undefined;
}
