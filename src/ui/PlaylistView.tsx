import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, ChevronDown, ChevronUp, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { itemHref } from "../capture/capture";
import { folderCtx } from "../folders/registry";
import type { Annotation, Folder, Item } from "../model";
import { deleteAnnotation, removeItem, renameItem, restoreItem, updateAnnotation } from "../store/actions";
import { navigate, toast } from "../store/ui";
import { addVideos, moveEntry, momentsOf, playlistEntries } from "../video/actions";
import { thumbnailUrl, youtubeId } from "../video/youtube";
import "../styles/video.css";
import { PromptDialog } from "./common";

/*
 * A playlist: its videos in order, each one a row you can move, remove or open. Videos can be added at any
 * time, from YouTube links pasted here. The list is one record per video, so two devices editing it both keep their change.
 */

interface Row {
  entry: Annotation;
  video?: Item;
  fraction: number;
  moments: number;
}

export function PlaylistView({ folder, item }: { folder: Folder; item: Item }) {
  const { db } = folderCtx(folder.id);
  const rows =
    useLiveQuery(async () => {
      const out: Row[] = [];
      for (const entry of await playlistEntries(folder.id, item.id)) {
        const video = entry.ref ? await db.items.get(entry.ref) : undefined;
        const pos = entry.ref ? await db.positions.get(entry.ref) : undefined;
        const moments = entry.ref ? (await momentsOf(folder.id, entry.ref)).length : 0;
        out.push({ entry, video: video && !video.deleted ? video : undefined, fraction: pos?.offset ?? 0, moments });
      }
      return out;
    }, [db, folder.id, item.id]) ?? [];

  const [paste, setPaste] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const add = async () => {
    if (!paste.trim()) return;
    const { added, skipped } = await addVideos(folder.id, item.id, paste);
    setPaste("");
    const parts = [
      added ? `Added ${added} video${added === 1 ? "" : "s"}.` : "No new YouTube videos in that.",
      skipped.length ? `Skipped ${skipped.length}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}` : "",
    ];
    setResult(parts.filter(Boolean).join(" "));
  };

  const move = (entryId: string, dir: -1 | 1) => void moveEntry(folder.id, item.id, entryId, dir);

  const remove = async (entryId: string) => {
    await deleteAnnotation(folder.id, entryId);
    toast("Removed from the playlist", { action: { label: "Undo", run: () => void updateAnnotation(folder.id, entryId, { deleted: false }) } });
  };

  const deletePlaylist = async () => {
    await removeItem(folder.id, item.id);
    navigate({ name: "library", folder: folder.id });
    toast(`Deleted "${item.title}".`, { action: { label: "Undo", run: () => void restoreItem(folder.id, item.id) } });
  };

  return (
    <main className="item-view playlist-view">
      <header className="topbar">
        <button className="icon-btn" aria-label={`Back to ${folder.name}`} onClick={() => navigate({ name: "library", folder: folder.id })}>
          <ArrowLeft size={20} />
        </button>
        <span className="muted">{folder.name}</span>
        <div className="spacer" />
        <button className="icon-btn" aria-label="Delete playlist" title="Delete playlist" onClick={() => void deletePlaylist()}>
          <Trash2 size={17} />
        </button>
      </header>

      <div className="playlist-body">
        <h1 className="playlist-title">
          <button className="folder-title" title="Rename" onClick={() => setRenaming(true)}>
            {item.title} <Pencil size={14} className="muted" />
          </button>
        </h1>
        <p className="muted playlist-count">
          {rows.length === 0 ? "No videos yet" : `${rows.length} video${rows.length === 1 ? "" : "s"}`}
        </p>

        {rows.length === 0 ? (
          <p className="notes-empty">Paste YouTube links below. Each one becomes a video in this playlist.</p>
        ) : (
          <ol className="playlist-list">
            {rows.map((row, i) => {
              const id = row.video?.sourceUrl ? youtubeId(row.video.sourceUrl) : null;
              return (
                <li key={row.entry.id} className="playlist-row">
                  <span className="playlist-no">{i + 1}</span>
                  <a className="playlist-thumb" href={row.video ? itemHref(folder.id, row.video) : undefined} aria-hidden="true" tabIndex={-1}>
                    {id ? <img src={thumbnailUrl(id)} alt="" loading="lazy" /> : null}
                  </a>
                  <div className="playlist-info">
                    <a href={row.video ? itemHref(folder.id, row.video) : undefined}>{row.video?.title ?? "Video removed"}</a>
                    <span className="muted">
                      {Math.round(row.fraction * 100)}% watched · {row.moments} note{row.moments === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="playlist-actions">
                    <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(row.entry.id, -1)}>
                      <ChevronUp size={16} />
                    </button>
                    <button className="icon-btn" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(row.entry.id, 1)}>
                      <ChevronDown size={16} />
                    </button>
                    <button className="icon-btn" aria-label="Remove from playlist" title="Remove from playlist" onClick={() => void remove(row.entry.id)}>
                      <X size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <div className="playlist-add">
          <label className="field-label" htmlFor="playlist-paste">
            Add videos
          </label>
          <textarea
            id="playlist-paste"
            rows={3}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste YouTube links, one per line"
          />
          <div className="playlist-add-row">
            <button className="btn btn-primary" onClick={() => void add()} disabled={!paste.trim()}>
              Add to playlist
            </button>
            {result && <span className="muted">{result}</span>}
          </div>
        </div>
      </div>

      {renaming && (
        <PromptDialog
          title="Rename playlist"
          label="Name"
          initial={item.title}
          action="Rename"
          onClose={() => setRenaming(false)}
          onSubmit={(name) => renameItem(folder.id, item.id, name)}
        />
      )}
    </main>
  );
}
