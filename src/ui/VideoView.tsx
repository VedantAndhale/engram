import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Play, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { folderCtx } from "../folders/registry";
import type { Folder, Item } from "../model";
import { piecesOf } from "../notes/images";
import { deleteAnnotation, updateAnnotation, updateItem } from "../store/actions";
import { navigate, toast } from "../store/ui";
import { addMoment, momentsOf, PLACEHOLDER_TITLE, saveVideoProgress } from "../video/actions";
import { mountPlayer, STATE, type Player } from "../video/player";
import { formatTime, parseMoment, thumbnailUrl, watchUrl, youtubeId } from "../video/youtube";
import "../styles/video.css";

// The Markdown editor, the same one the notes elsewhere use, loaded when a video page first needs it.
const Editor = lazy(() => import("../editor/Editor"));

/*
 * One video: its player and note box stay at the top of the page, and its timed notes scroll beneath them.
 * A note is stamped with the time the player is at, unless the note starts with a time such as @1:30.
 * Ctrl+Enter saves a note, as it does in the other notes; Enter starts a new line.
 */

const ERRORS: Record<number, string> = {
  100: "This video was removed, or it is private.",
  101: "Its owner doesn't allow it to play outside YouTube.",
  150: "Its owner doesn't allow it to play outside YouTube.",
};

/** The position is resumed when it is in the middle of the video; near the end counts as watched. */
const RESUME_BEFORE = 0.97;

export function VideoView({ folder, item }: { folder: Folder; item: Item }) {
  const { db } = folderCtx(folder.id);
  const videoId = youtubeId(item.sourceUrl ?? "");
  const moments = useLiveQuery(() => momentsOf(folder.id, item.id), [folder.id, item.id]) ?? [];
  const position = useLiveQuery(() => db.positions.get(item.id), [db, item.id]);

  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [draft, setDraft] = useState("");
  // Changes after each saved note, which starts the note editor afresh, empty and with the focus.
  const [draftKey, setDraftKey] = useState(0);
  // `was` is the note as it was when the edit began. Only a change typed here is written back.
  const [editing, setEditing] = useState<{ id: string; text: string; was: string } | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const seekOnReady = useRef<number | null>(null);
  const fraction = useRef<number | undefined>(undefined);
  fraction.current = position?.offset;

  // The player exists only while the video is playing. Leaving the page, or pausing it away, saves where it was.
  useEffect(() => {
    if (!playing || !videoId || !holder.current) return;
    const el = holder.current;
    const inner = document.createElement("div");
    el.append(inner);
    let live = true;
    let ticks = 0;
    const save = () => {
      const p = player.current;
      const d = p?.duration() ?? 0;
      if (p && d > 0) void saveVideoProgress(folder.id, item.id, p.currentTime() / d);
    };
    const interval = window.setInterval(() => {
      const p = player.current;
      if (!p) return;
      setNow(p.currentTime());
      // While it plays, the place is saved about every twenty seconds, so an interrupted visit still keeps it.
      if (++ticks % 40 === 0) save();
    }, 500);

    mountPlayer(inner, videoId, {
      ready: (p) => {
        if (!live) return p.destroy();
        player.current = p;
        const title = p.title();
        if (title && (!item.title.trim() || item.title.startsWith(PLACEHOLDER_TITLE))) void updateItem(folder.id, item.id, { title });
        const d = p.duration();
        if (seekOnReady.current !== null) {
          p.seek(seekOnReady.current);
          seekOnReady.current = null;
          p.play();
        } else if (d > 0 && fraction.current && fraction.current > 0 && fraction.current < RESUME_BEFORE) {
          p.seek(fraction.current * d);
        }
        setNow(p.currentTime());
      },
      state: (s) => {
        if (s === STATE.PAUSED || s === STATE.ENDED) save();
      },
      error: (code) => setError(ERRORS[code] ?? "This video can't play here."),
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      live = false;
      window.clearInterval(interval);
      save();
      player.current?.destroy();
      player.current = null;
      el.replaceChildren();
    };
  }, [playing, videoId, folder.id, item.id]);

  /** Plays from a time: at once when the player is up, or as soon as it is ready. */
  const seek = (at: number) => {
    if (player.current) {
      player.current.seek(at);
      player.current.play();
    } else {
      seekOnReady.current = at;
      setPlaying(true);
    }
  };

  /** Where the player is now, or where it last was. */
  const timeNow = () => player.current?.currentTime() ?? now;

  const submit = async () => {
    const typed = draft.trim();
    if (!typed) return;
    const { at, text } = parseMoment(typed);
    await addMoment(folder.id, item.id, at ?? timeNow(), text);
    setDraft("");
    setDraftKey((k) => k + 1);
  };

  const removeMoment = async (id: string) => {
    await deleteAnnotation(folder.id, id);
    toast("Note deleted", { action: { label: "Undo", run: () => void updateAnnotation(folder.id, id, { deleted: false }) } });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    setEditing(null);
    // A note another device changed while this box was open keeps that change, unless it was typed over here.
    if (text !== editing.was.trim()) await updateAnnotation(folder.id, editing.id, { note: text });
  };

  // An edit still open is saved when the page is hidden, closed or left. A tap can leave before the editor's blur
  // runs, and a discarded tab never runs the unmount, so the typed words would otherwise be lost.
  const editingNow = useRef(editing);
  editingNow.current = editing;
  const saveOpenEdit = () => {
    const e = editingNow.current;
    if (e && e.text.trim() !== e.was.trim()) void updateAnnotation(folder.id, e.id, { note: e.text.trim() });
  };
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveOpenEdit();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", saveOpenEdit);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", saveOpenEdit);
      saveOpenEdit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id]);

  return (
    <main className="item-view video-view">
      <header className="topbar">
        <button
          className="icon-btn"
          aria-label={`Back to ${folder.name}`}
          onClick={() => {
            void saveEdit();
            navigate({ name: "library", folder: folder.id });
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <span className="muted">{folder.name}</span>
        <div className="spacer" />
      </header>

      <div className="video-top">
        {videoId ? (
          <div className="video-frame">
            {playing ? (
              <div ref={holder} className="video-player" />
            ) : (
              <button className="video-facade" onClick={() => setPlaying(true)} aria-label={`Play ${item.title}`}>
                <img src={thumbnailUrl(videoId)} alt="" loading="lazy" />
                <span className="video-play">
                  <Play size={34} fill="currentColor" />
                </span>
              </button>
            )}
          </div>
        ) : (
          <p className="video-error">This isn't a YouTube link, so it can't play here.</p>
        )}
        {error && videoId && (
          <div className="video-error" role="alert">
            <p>{error}</p>
            <a href={watchUrl(videoId)} target="_blank" rel="noreferrer noopener">
              Watch on YouTube
            </a>
          </div>
        )}
        <p className="video-title" title={item.title}>
          {item.title}
          {playing && <span className="muted"> · {formatTime(now)}</span>}
        </p>

        <p className="hint">Note at {formatTime(timeNow())}</p>
        <div className="note-editor video-note">
          <Suspense fallback={<div className="md-editor md-loading" />}>
            <Editor
              key={draftKey}
              value={draft}
              onChange={setDraft}
              titles={() => []}
              openWiki={() => {}}
              highlights={async () => []}
              embed={async () => null}
              // After a save, the next note is ready to type straight away.
              autoFocus={draftKey > 0}
              label="New note"
              placeholder="Start with @1:30 to set another time. Ctrl+Enter saves. Paste a screenshot here."
              onSubmit={() => void submit()}
            />
          </Suspense>
        </div>
      </div>

      <section className="video-moments" aria-label="Notes at times">
        {moments.length === 0 ? (
          <p className="notes-empty">Notes you write here stay at the time you wrote them, so you can jump back to that moment.</p>
        ) : (
          <ol className="moment-list">
            {moments.map((m) => (
              <li key={m.id} className="moment">
                <button className="moment-time" onClick={() => seek(m.at ?? 0)} title="Play from here">
                  {formatTime(m.at ?? 0)}
                </button>
                {editing?.id === m.id ? (
                  <div className="note-editor moment-note">
                    <Suspense fallback={<div className="md-editor md-loading" />}>
                      <Editor
                        value={editing.text}
                        onChange={(text) => setEditing((cur) => (cur && cur.id === m.id ? { ...cur, text } : cur))}
                        titles={() => []}
                        openWiki={() => {}}
                        highlights={async () => []}
                        embed={async () => null}
                        autoFocus
                        label="Edit note"
                        onSubmit={() => void saveEdit()}
                        onBlur={() => void saveEdit()}
                      />
                    </Suspense>
                  </div>
                ) : (
                  <div
                    className="moment-text"
                    onClick={() => {
                      // Opening another note saves the one being edited first.
                      void saveEdit();
                      setEditing({ id: m.id, text: m.note ?? "", was: m.note ?? "" });
                    }}
                    title="Click to edit"
                  >
                    {piecesOf(m.note ?? "").map((p, i) =>
                      "src" in p ? <img key={i} className="moment-picture" src={p.src} alt={p.alt} /> : <span key={i}>{p.text}</span>,
                    )}
                  </div>
                )}
                <button className="icon-btn moment-delete" aria-label="Delete note" title="Delete note" onClick={() => void removeMoment(m.id)}>
                  <X size={15} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
