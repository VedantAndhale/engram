/*
 * YouTube links and times, with no network. A video is kept under its watch link, so the same video
 * pasted in any form is one video. Only YouTube is supported for now.
 */

/** A YouTube video id: eleven letters, digits, - or _. */
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

/** The video id in a YouTube link (watch, youtu.be, shorts, embed or live), or null for anything else. */
export function youtubeId(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0] || null;
  else if (u.pathname === "/watch") id = u.searchParams.get("v");
  else id = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname)?.[1] ?? null;
  return id && ID.test(id) ? id : null;
}

/** The address a video is kept under. */
export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** The still picture shown for a video before it is played. It is loaded from YouTube when shown, not stored. */
export const thumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/**
 * The YouTube videos in a paste, one per link, in order and without repeats. Lines with a web address
 * that isn't YouTube are returned as rejected, so the reader can see what was skipped.
 */
export function videosIn(text: string): { ids: string[]; rejected: string[] } {
  const ids: string[] = [];
  const rejected: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const links = line.match(/https?:\/\/\S+/g) ?? [];
    if (!links.length) {
      rejected.push(line);
      continue;
    }
    for (const link of links) {
      const id = youtubeId(link);
      if (id) {
        if (!ids.includes(id)) ids.push(id);
      } else rejected.push(link);
    }
  }
  return { ids, rejected };
}

/**
 * A time as typed: 75 seconds, 1:15, or 1:02:03. Null when it isn't one. Minutes and seconds must be under 60
 * when hours are given, and seconds always.
 */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const [h, m, s] = parts.length === 3 ? nums : [0, ...nums];
  if ((parts.length === 3 && m >= 60) || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}

/** A time as shown: 1:05, or 1:02:03 from an hour. */
export function formatTime(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * A moment as typed. "@1:30 the point" is at 1:30. "the point" and "@ the point" are at the current time.
 * "@word" is not a time, so it is kept as written.
 */
export function parseMoment(line: string): { at: number | null; text: string } {
  const t = line.trim();
  const m = /^@(\S*)\s*([\s\S]*)$/.exec(t);
  if (!m) return { at: null, text: t };
  if (m[1] === "") return { at: null, text: m[2].trim() };
  const at = parseTime(m[1]);
  if (at === null) return { at: null, text: t };
  return { at, text: m[2].trim() };
}
