import { folderCtx } from "../folders/registry";
import type { Annotation, Item } from "../model";
import { createItem, restoreItem, saveAnnotation, savePosition, updateAnnotation } from "../store/actions";
import { fillDuration } from "./duration";
import { orderAfterMove } from "./order";
import { playlistIdOf, playlistName, playlistUrl, playlistVideoIds } from "./playlist";
import { fillVideoTitle } from "./title";
import { videosIn, watchUrl } from "./youtube";

/*
 * Playlists and videos, kept in the folder like everything else. A playlist is an item; each video in it
 * is an "entry" annotation on the playlist, and each timed note is a "moment" annotation on its video. Each is
 * one record, so two devices that change different entries, or different moments, both keep their change.
 */

/** The title a video has until its player says what it really is. */
export const PLACEHOLDER_TITLE = "YouTube video";

/** A playlist's entries, in order, without the removed ones. */
export async function playlistEntries(folder: string, playlistId: string): Promise<Annotation[]> {
  const { db } = folderCtx(folder);
  const rows = await db.annotations.where("doc").equals(playlistId).toArray();
  return rows
    .filter((a) => a.kind === "entry" && !a.deleted)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** A video's moments, in the order they happen, without the removed ones. */
export async function momentsOf(folder: string, videoId: string): Promise<Annotation[]> {
  const { db } = folderCtx(folder);
  const rows = await db.annotations.where("doc").equals(videoId).toArray();
  return rows
    .filter((a) => a.kind === "moment" && !a.deleted)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/**
 * The video item for a YouTube id in this folder. Made the first time, and shared by every playlist that lists it.
 * A video that was removed comes back with its notes, rather than a second copy being made.
 */
export async function videoFor(folder: string, id: string): Promise<Item> {
  const { db } = folderCtx(folder);
  const url = watchUrl(id);
  const rows = await db.items.filter((i) => i.type === "video" && i.sourceUrl === url).toArray();
  const live = rows.find((i) => !i.deleted);
  if (live) return live;
  const removed = rows[0];
  if (removed) {
    await restoreItem(folder, removed.id);
    return { ...removed, deleted: undefined };
  }
  const video = await createItem(folder, { type: "video", title: `${PLACEHOLDER_TITLE} ${id}`, sourceUrl: url });
  // Its real title is asked of YouTube in the background, so the playlist doesn't wait for it.
  void fillVideoTitle(folder, video.id);
  return video;
}

export async function createPlaylist(folder: string, name: string): Promise<Item> {
  return createItem(folder, { type: "playlist", title: name.trim() || "Playlist" });
}

/**
 * A YouTube playlist saved as a playlist here: its name and videos come from its page, through Engram's
 * server, and the videos are added in the order the page lists them.
 */
export async function importPlaylist(folder: string, url: string): Promise<{ playlist: Item; added: number }> {
  const id = playlistIdOf(url);
  if (!id) throw new Error("That isn't a YouTube playlist.");
  const res = await fetch(`/api/page?url=${encodeURIComponent(playlistUrl(id))}`);
  if (!res.ok) throw new Error("Couldn't read that playlist.");
  const html = await res.text();
  const ids = playlistVideoIds(html, id);
  if (!ids.length) throw new Error("No videos were found in that playlist.");
  const playlist = await createPlaylist(folder, playlistName(html) ?? "Playlist");
  const { added } = await addVideos(folder, playlist.id, ids.map(watchUrl).join("\n"));
  // Each video's length is read from its own page, one at a time, after the save has returned.
  void (async () => {
    for (const entry of await playlistEntries(folder, playlist.id)) if (entry.ref) await fillDuration(folder, entry.ref);
  })();
  return { playlist, added };
}

/**
 * Lists the YouTube videos in a paste at the end of a playlist. A video already in the playlist is
 * skipped, and so is anything that isn't a YouTube link; both are reported back.
 */
export async function addVideos(folder: string, playlistId: string, text: string): Promise<{ added: number; skipped: string[] }> {
  const { ids, rejected } = videosIn(text);
  const entries = await playlistEntries(folder, playlistId);
  const listed = new Set(entries.map((e) => e.ref));
  let order = entries.reduce((max, e) => Math.max(max, e.order ?? 0), 0);
  let added = 0;
  for (const id of ids) {
    const video = await videoFor(folder, id);
    if (listed.has(video.id)) continue;
    listed.add(video.id);
    order += 1;
    await saveAnnotation(folder, { doc: playlistId, kind: "entry", page: 0, color: "", ref: video.id, order });
    added += 1;
  }
  return { added, skipped: rejected };
}

/**
 * Moves an entry up or down one place. Only the moved entry is written: it takes an order between its new
 * neighbours, so two devices moving different entries both keep their change.
 */
export async function moveEntry(folder: string, playlistId: string, entryId: string, dir: -1 | 1): Promise<void> {
  const list = await playlistEntries(folder, playlistId);
  const i = list.findIndex((e) => e.id === entryId);
  const order = orderAfterMove(
    list.map((e) => e.order ?? 0),
    i,
    dir,
  );
  if (order === null) return;
  await updateAnnotation(folder, entryId, { order });
}

/** A timed note on a video. `at` is in seconds. */
export async function addMoment(folder: string, videoId: string, at: number, note: string): Promise<Annotation> {
  return saveAnnotation(folder, { doc: videoId, kind: "moment", page: 0, color: "", at: Math.max(0, Math.floor(at)), note: note.trim() });
}

/** Where a video's player was left, as the fraction watched. It syncs like a PDF's position. */
export async function saveVideoProgress(folder: string, videoId: string, fraction: number): Promise<void> {
  await savePosition(folder, videoId, 0, Math.min(1, Math.max(0, fraction)));
}
