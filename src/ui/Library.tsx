import { useLiveQuery } from "dexie-react-hooks";
import {
  Archive,
  Clock,
  CloudUpload,
  Copy,
  Ellipsis,
  FileText,
  FolderInput,
  Inbox,
  ListVideo,
  LoaderCircle,
  Menu as MenuIcon,
  NotebookPen,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Tag,
  Trash2,
  BookUp,
  Upload,
  X,
} from "lucide-react";
import { ImportDialog } from "../import/ImportDialog";
import { hostOf, itemHref, titleFromText, TYPE_LABELS } from "../capture/capture";
import { useEffect, useRef, useState } from "react";
import { folderCtx, renameFolder, setAttention, visibleFolders } from "../folders/registry";
import { formatBytes, timeAgo } from "../lib/util";
import { isDailyNote, itemLocation, type Folder, type Item, type ItemType, type Location, type Position } from "../model";
import { partlyRead } from "../reader/articlePosition";
import { addPdf, copyItem, isFinished, moveItem, purgeItem, removeItem, restoreItem, setFavorite, setItemTopics, setLocation } from "../store/actions";
import { renameWithLinks } from "../notes/notes";
import { createPlaylist } from "../video/actions";
import { setHabit, useHabit } from "../habit/prefs";
import { TopicsDialog } from "./habit";
import { navigate, openQuickAdd, rememberFolder, toast } from "../store/ui";
import { useAccount } from "../sync/account";
import { useGrantAccess } from "./grantaccess";
import { ConfirmDialog, Modal, PrivateBadge, PromptDialog, SyncBadge, useFolderSync, useMenu, type MenuItem } from "./common";
import "../styles/library.css";

type Sort = "recent" | "added" | "title";

/** Which part of the library is shown. Inbox, Later and Archive are where items sit; the rest cut across them. */
type View = Location | "all" | "favorites" | "trash";

/** Narrow the list to one kind of item. "daily" is the day's notes, which are otherwise only under All. */
type TypeFilter = ItemType | "daily" | "";

const VIEWS: { id: View; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "later", label: "Later" },
  { id: "archive", label: "Archive" },
  { id: "all", label: "All" },
  { id: "favorites", label: "Favourites" },
  { id: "trash", label: "Trash" },
];

const LOCATION_LABEL: Record<Location, string> = { inbox: "Inbox", later: "Later", archive: "Archive" };

/**
 * What a card needs of an item: everything but its words and saved text, which can be long.
 * The few lines a card shows are cut out once, when the list is read.
 */
type Row = Omit<Item, "body" | "content"> & { excerpt: string };

/** A card's few lines: a note's words after its title, or the start of a saved page. */
function excerptOf(item: Item): string {
  if (item.type === "pdf" || item.type === "playlist" || item.type === "quote") return "";
  let text = (item.type === "note" ? item.body : (item.content ?? item.body)) ?? "";
  // A note's first line is already its title.
  if (item.type === "note" && titleFromText(text) === item.title) text = text.trim().split(/\r?\n/).slice(1).join(" ");
  // Formatted articles: images go, links keep their words.
  if (item.type !== "note" && item.contentFormat === "markdown") {
    text = text
      .slice(0, 4_000)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\\(.)/g, "$1");
  }
  // Longer than the cover shows, so its fade-out has words to fade.
  return text.slice(0, 2_000).replace(/[#>*_`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");

export function Library({ folder, onOpenSidebar }: { folder: Folder; onOpenSidebar: () => void }) {
  const { db, sync } = folderCtx(folder.id);
  const s = useFolderSync(folder.id);
  const account = useAccount((a) => a.account);
  const access = useGrantAccess(folder, s.message);
  const backupDismissed = useHabit((h) => h.backupDismissed);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem("reader.sort") as Sort) ?? "recent");
  const [view, setViewState] = useState<View>(() => (localStorage.getItem("reader.view") as View | null) ?? "inbox");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("");
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<
    | { kind: "rename" | "copy" | "topics"; doc: Row }
    | { kind: "move" | "purge"; ids: string[] }
    | { kind: "renameFolder" }
    | { kind: "newPlaylist" }
    | null
  >(null);
  const topics = useHabit((h) => h.topics);
  const [adding, setAdding] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const menu = useMenu();
  // After an item leaves the list from the keyboard, the next one takes focus.
  const focusNext = useRef<string | null>(null);

  const setView = (v: View) => {
    setViewState(v);
    setSelected(new Set());
    localStorage.setItem("reader.view", v);
  };

  useEffect(() => {
    rememberFolder(folder.id);
    setAttention(folder.id, "open");
  }, [folder.id]);

  const rows = useLiveQuery(async () => {
    const out: Row[] = [];
    await db.items.each((i) => {
      if (i.purged) return;
      const { body: _body, content: _content, ...rest } = i;
      out.push({ ...rest, excerpt: excerptOf(i) });
    });
    return out;
  }, [db]);
  const positions = useLiveQuery(async () => new Map((await db.positions.toArray()).map((p) => [p.doc, p])), [db]);
  const thumbs = useLiveQuery(async () => new Map((await db.thumbs.toArray()).map((t) => [t.hash, t.dataUrl])), [db]);
  const counts = useLiveQuery(async () => {
    const notes = new Map<string, number>();
    const videos = new Map<string, number>();
    await db.annotations.each((a) => {
      if (a.deleted) return;
      // A playlist's entries are its videos, counted on their own, not as notes.
      const m = a.kind === "entry" ? videos : notes;
      m.set(a.doc, (m.get(a.doc) ?? 0) + 1);
    });
    return { notes, videos };
  }, [db]);
  const notes = counts?.notes;
  const videos = counts?.videos;

  const live = (rows ?? []).filter((d) => !d.deleted);
  const trash = (rows ?? []).filter((d) => d.deleted);
  const where = (d: Row) => itemLocation(d, isFinished(d, positions?.get(d.id)));
  const inView = (d: Row) =>
    view === "trash" ? !!d.deleted : view === "all" ? true : view === "favorites" ? !!d.favorite : where(d) === view;
  const pool = view === "trash" ? trash : live.filter(inView);
  const ofType = (d: Row) => (typeFilter === "daily" ? isDailyNote(d) : typeFilter === "note" ? d.type === "note" && !isDailyNote(d) : d.type === typeFilter);

  const sorted = [...pool].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "added") return b.addedAt - a.addedAt;
    const ra = positions?.get(a.id)?.updatedAt ?? a.addedAt;
    const rb = positions?.get(b.id)?.updatedAt ?? b.addedAt;
    return rb - ra;
  });

  // The kinds of item in this view, for the type filter. A kind no longer here drops the filter.
  const kinds = new Map<TypeFilter, number>();
  for (const d of pool) {
    const k: TypeFilter = isDailyNote(d) ? "daily" : d.type;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const activeType = typeFilter && kinds.has(typeFilter) ? typeFilter : "";

  // Topics in use, most used first. A topic that no longer appears on any item drops the filter.
  const topicCounts = new Map<string, number>();
  for (const d of pool) for (const t of d.topics ?? []) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  const topicList = [...topicCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const activeTopic = topicFilter && topicCounts.has(topicFilter) ? topicFilter : null;
  const shown = sorted.filter((d) => (!activeType || ofType(d)) && (!activeTopic || d.topics?.includes(activeTopic)));
  const chosen = shown.filter((d) => selected.has(d.id));
  const tally = (l: Location) => live.filter((d) => where(d) === l).length;

  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    document.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"] .doc-card`)?.focus();
  });

  const addFiles = async (files: Iterable<File>) => {
    const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!pdfs.length) {
      toast("Only PDF files can be added.");
      return;
    }
    setAdding((n) => n + pdfs.length);
    let last: string | null = null;
    for (const f of pdfs) {
      try {
        last = await addPdf(folder.id, f);
      } catch (e) {
        console.error(e);
        toast(`Couldn't read ${f.name}. Is it a valid PDF?`);
      } finally {
        setAdding((n) => n - 1);
      }
    }
    if (pdfs.length === 1 && last) toast(`Added to ${folder.name}.`);
    else if (pdfs.length > 1) toast(`Added ${pdfs.length} PDFs to ${folder.name}.`);
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  // Accept PDFs dropped anywhere on the window while the library is open. Registered once, so the
  // count of drag-enters and -leaves isn't reset by a render mid-drag.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void addFilesRef.current(e.dataTransfer!.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const toTrash = async (items: Row[]) => {
    for (const d of items) await removeItem(folder.id, d.id);
    setSelected(new Set());
    toast(items.length === 1 ? `Moved "${items[0].title}" to Trash.` : `Moved ${items.length} items to Trash.`, {
      action: { label: "Undo", run: () => void Promise.all(items.map((d) => restoreItem(folder.id, d.id))) },
    });
  };

  const restore = async (items: Row[]) => {
    for (const d of items) await restoreItem(folder.id, d.id);
    setSelected(new Set());
    toast(items.length === 1 ? `Restored "${items[0].title}".` : `Restored ${items.length} items.`);
  };

  const moveTo = async (items: Row[], to: Location) => {
    const from = new Map(items.map((d) => [d.id, where(d)]));
    const moving = items.filter((d) => from.get(d.id) && from.get(d.id) !== to);
    if (!moving.length) return;
    await setLocation(folder.id, moving.map((d) => d.id), to);
    setSelected(new Set());
    toast(moving.length === 1 ? `Moved to ${LOCATION_LABEL[to]}.` : `Moved ${moving.length} items to ${LOCATION_LABEL[to]}.`, {
      action: {
        label: "Undo",
        run: () => void Promise.all(moving.map((d) => setLocation(folder.id, [d.id], from.get(d.id)!))),
      },
    });
  };

  const toggleFavorite = (d: Row) => {
    void setFavorite(folder.id, d.id, !d.favorite);
    toast(d.favorite ? "Removed from Favourites." : "Added to Favourites.");
  };

  // Keys on the library: E archive, L later, I inbox, S favourite, X select, # or Delete to Trash.
  // They act on the focused card (J and K move between cards), or on the selection when no card has focus.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector(".modal, .menu")) return;
    if (e.key === "Escape" && selected.size) {
      setSelected(new Set());
      return;
    }
    const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-item]")?.dataset.item;
    const focused = id ? shown.find((d) => d.id === id) : undefined;
    const targets = focused ? [focused] : chosen;
    if (!targets.length) return;
    const key = e.key.toLowerCase();
    const leaving = (go: () => void) => {
      if (focused) {
        const at = shown.indexOf(focused);
        focusNext.current = (shown[at + 1] ?? shown[at - 1])?.id ?? null;
      }
      go();
    };
    if (view === "trash") {
      if (key === "x" && focused) toggleSelect(focused.id);
      else if (key === "u") leaving(() => void restore(targets));
      else return;
    } else if (key === "x" && focused) toggleSelect(focused.id);
    else if (key === "s") targets.forEach(toggleFavorite);
    else if (key === "e" || key === "l" || key === "i") {
      const to: Location = key === "e" ? "archive" : key === "l" ? "later" : "inbox";
      const goes = view === "inbox" || view === "later" || view === "archive" ? view !== to : false;
      if (goes) leaving(() => void moveTo(targets, to));
      else void moveTo(targets, to);
    } else if (e.key === "#" || e.key === "Delete") leaving(() => void toTrash(targets));
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSelect = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const docMenu = (e: React.MouseEvent, d: Row) => {
    if (d.deleted) {
      return menu.open(e, [
        { label: "Restore", icon: <RotateCcw size={15} />, run: () => void restore([d]) },
        { label: "Delete forever", icon: <Trash2 size={15} />, danger: true, run: () => setDialog({ kind: "purge", ids: [d.id] }) },
      ]);
    }
    const at = where(d);
    const places: MenuItem[] = at
      ? (["inbox", "later", "archive"] as const)
          .filter((l) => l !== at)
          .map((l) => ({
            label: l === "inbox" ? "Move to Inbox" : l === "later" ? "Read later" : "Archive",
            icon: l === "inbox" ? <Inbox size={15} /> : l === "later" ? <Clock size={15} /> : <Archive size={15} />,
            run: () => void moveTo([d], l),
          }))
      : [];
    menu.open(e, [
      ...places,
      { label: d.favorite ? "Remove from Favourites" : "Add to Favourites", icon: <Star size={15} />, run: () => toggleFavorite(d) },
      { label: "Rename", icon: <Pencil size={15} />, run: () => setDialog({ kind: "rename", doc: d }) },
      { label: "Topics", icon: <Tag size={15} />, run: () => setDialog({ kind: "topics", doc: d }) },
      // A PDF's notes live on the PDF, so they are reached from it rather than listed as items.
      ...(d.type === "pdf" && (notes?.get(d.id) ?? 0) > 0
        ? [{ label: "View notes", icon: <NotebookPen size={15} />, run: () => navigate({ name: "reader", folder: folder.id, doc: d.id, panel: "notes" }) }]
        : []),
      { label: "Move to another folder", icon: <FolderInput size={15} />, run: () => setDialog({ kind: "move", ids: [d.id] }) },
      ...(d.type === "pdf" ? [{ label: "Copy to another folder", icon: <Copy size={15} />, run: () => setDialog({ kind: "copy", doc: d }) }] : []),
      { label: "Move to Trash", icon: <Trash2 size={15} />, danger: true, run: () => void toTrash([d]) },
    ]);
  };

  const emptyAll = rows && live.length === 0 && trash.length === 0;
  const offerBackup = !account && !backupDismissed && live.length > 0;

  return (
    <main className="library">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <h1>
          <button className="folder-title" title="Rename folder" onClick={() => setDialog({ kind: "renameFolder" })}>
            {folder.name}
          </button>
        </h1>
        {folder.repo && <PrivateBadge isPrivate={folder.isPrivate} />}
        <div className="spacer" />
        <SyncBadge s={s} onClick={() => (account ? void sync.flush() : navigate({ name: "setup" }))} />
        <select
          className="select"
          value={sort}
          aria-label="Sort by"
          title="Sort by"
          onChange={(e) => {
            setSort(e.target.value as Sort);
            localStorage.setItem("reader.sort", e.target.value);
          }}
        >
          <option value="recent">Last read</option>
          <option value="added">Newest</option>
          <option value="title">A–Z</option>
        </select>
        <button className="btn" aria-label="New playlist" title="A list of YouTube videos, in order" onClick={() => setDialog({ kind: "newPlaylist" })}>
          <ListVideo size={16} /> <span className="hide-narrow">New playlist</span>
        </button>
        <button className="btn" aria-label="Add PDF" onClick={() => fileInput.current?.click()}>
          <Upload size={16} /> <span className="hide-narrow">Add PDF</span>
        </button>
        <button className="btn" aria-label="Import highlights" title="Import highlights from a Kindle or Readwise export" onClick={() => setImporting(true)}>
          <BookUp size={16} /> <span className="hide-narrow">Import</span>
        </button>
        <button className="btn btn-primary" aria-label="Save" title="Save a link, a quote or a note (N)" onClick={() => openQuickAdd({ folder: folder.id })}>
          <Plus size={16} /> <span className="hide-narrow">Save</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </header>

      {s.message && (s.state === "error" || s.state === "auth" || s.state === "pending") && (
        <div className={`banner ${s.state === "pending" ? "" : "banner-warn"}`}>
          <span>{s.message}</span>
          {s.state === "auth" && (
            <button className="btn btn-small" onClick={() => navigate({ name: "setup" })}>
              Sign in again
            </button>
          )}
          {access.needed && (
            <button className="btn btn-small" disabled={access.granting} onClick={() => void access.grant()}>
              {access.granting ? "Adding…" : "Give Engram access"}
            </button>
          )}
        </div>
      )}
      {folder.isPrivate === false && (
        <div className="banner banner-warn">
          This folder's repository is public. Anyone can see its PDFs and notes. Make it private on GitHub.
        </div>
      )}
      {offerBackup && (
        <div className="banner backup-nudge">
          <CloudUpload size={16} />
          <span>Your library is only in this browser. Connect GitHub to keep a private copy and use it on your other devices.</span>
          <button className="btn btn-small" onClick={() => navigate({ name: "setup" })}>
            Back up
          </button>
          <button className="icon-btn" aria-label="Not now" title="Not now" onClick={() => setHabit({ backupDismissed: true })}>
            <X size={16} />
          </button>
        </div>
      )}

      {adding > 0 && (
        <div className="banner">
          <LoaderCircle size={14} className="spin" /> Adding {adding} PDF{adding === 1 ? "" : "s"}…
        </div>
      )}

      {!emptyAll && (
        <div className="library-bar">
          <div className="views" role="group" aria-label="Show">
            {VIEWS.filter((v) => v.id !== "trash" || trash.length > 0 || view === "trash").map((v) => {
              const n = v.id === "inbox" || v.id === "later" ? tally(v.id) : v.id === "trash" ? trash.length : 0;
              return (
                <button key={v.id} className={`view ${view === v.id ? "on" : ""}`} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                  {v.label}
                  {n > 0 && <span className="view-count">{n}</span>}
                </button>
              );
            })}
          </div>
          {kinds.size > 1 && (
            <select className="select" value={activeType} aria-label="Type" title="Show one kind of item" onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}>
              <option value="">All types</option>
              {[...kinds.keys()]
                .sort((a, b) => label(a).localeCompare(label(b)))
                .map((k) => (
                  <option key={k} value={k}>
                    {label(k)} ({kinds.get(k)})
                  </option>
                ))}
            </select>
          )}
        </div>
      )}

      {topicList.length > 0 && (
        <div className="chips topic-filter" role="group" aria-label="Filter by topic">
          {topicList.map(([t, n]) => (
            <button
              key={t}
              className={`chip ${activeTopic === t ? "on" : ""}`}
              aria-pressed={activeTopic === t}
              onClick={() => setTopicFilter(activeTopic === t ? null : t)}
            >
              {t} <span className="topic-count">{n}</span>
            </button>
          ))}
        </div>
      )}

      {chosen.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected items">
          <label className="bulk-all">
            <input
              type="checkbox"
              checked={chosen.length === shown.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((d) => d.id)) : new Set())}
            />
            <span>{chosen.length} selected</span>
          </label>
          {view === "trash" ? (
            <>
              <button className="btn btn-small" onClick={() => void restore(chosen)}>
                <RotateCcw size={14} /> Restore
              </button>
              <button className="btn btn-small btn-danger" onClick={() => setDialog({ kind: "purge", ids: chosen.map((d) => d.id) })}>
                <Trash2 size={14} /> Delete forever
              </button>
            </>
          ) : (
            <>
              {view !== "inbox" && (
                <button className="btn btn-small" onClick={() => void moveTo(chosen, "inbox")}>
                  <Inbox size={14} /> Inbox
                </button>
              )}
              {view !== "later" && (
                <button className="btn btn-small" onClick={() => void moveTo(chosen, "later")}>
                  <Clock size={14} /> Later
                </button>
              )}
              {view !== "archive" && (
                <button className="btn btn-small" onClick={() => void moveTo(chosen, "archive")}>
                  <Archive size={14} /> Archive
                </button>
              )}
              <button className="btn btn-small" onClick={() => setDialog({ kind: "move", ids: chosen.map((d) => d.id) })}>
                <FolderInput size={14} /> Move to folder
              </button>
              <button className="btn btn-small" onClick={() => void toTrash(chosen)}>
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}
          <div className="spacer" />
          <button className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}>
            <X size={16} />
          </button>
        </div>
      )}

      {emptyAll ? (
        <div className="empty">
          <FileText size={40} strokeWidth={1.4} />
          <h2>Nothing here yet</h2>
          <p>Save a link, a quote or a note, or drop PDFs here.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => openQuickAdd({ folder: folder.id })}>
              <Plus size={16} /> Save
            </button>
            <button className="btn" onClick={() => fileInput.current?.click()}>
              <Upload size={16} /> Add PDF
            </button>
          </div>
        </div>
      ) : rows && shown.length === 0 ? (
        <div className="empty empty-view">
          <h2>{EMPTY[view].title}</h2>
          <p>{activeType || activeTopic ? "Nothing here matches the filter." : EMPTY[view].text}</p>
        </div>
      ) : (
        <>
          {view === "trash" && <p className="hint view-hint">Items in the Trash stay until you delete them for good. Restore one to put it back where it was.</p>}
          <ul className={`doc-grid ${chosen.length ? "selecting" : ""}`}>
            {shown.map((d) => (
              <Card
                key={d.id}
                folder={folder.id}
                item={d}
                position={positions?.get(d.id)}
                thumb={thumbs?.get(d.id)}
                notes={notes?.get(d.id) ?? 0}
                videos={videos?.get(d.id) ?? 0}
                selected={selected.has(d.id)}
                onSelect={() => toggleSelect(d.id)}
                onMenu={(e) => docMenu(e, d)}
                onRestore={() => void restore([d])}
                onPurge={() => setDialog({ kind: "purge", ids: [d.id] })}
              />
            ))}
          </ul>
        </>
      )}

      {dragging && (
        <div className="drop-overlay">
          <Upload size={32} />
          <span>Drop PDFs to add them to {folder.name}</span>
        </div>
      )}

      {menu.node}

      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {dialog?.kind === "rename" && (
        <PromptDialog
          title="Rename"
          label="Title"
          initial={dialog.doc.title}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(t) => renameWithLinks(folder.id, dialog.doc.id, t)}
        />
      )}
      {dialog?.kind === "renameFolder" && (
        <PromptDialog
          title="Rename folder"
          label="Name"
          initial={folder.name}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(name) => renameFolder(folder.id, name)}
        />
      )}
      {dialog?.kind === "newPlaylist" && (
        <PromptDialog
          title="New playlist"
          label="Name"
          initial=""
          action="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const playlist = await createPlaylist(folder.id, name);
            navigate({ name: "item", folder: folder.id, item: playlist.id });
          }}
        />
      )}
      {dialog?.kind === "copy" && <CopyDialog from={folder} doc={dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.kind === "move" && (
        <MoveDialog
          from={folder}
          items={(rows ?? []).filter((d) => dialog.ids.includes(d.id))}
          onDone={() => setSelected(new Set())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "purge" && (
        <ConfirmDialog
          title={dialog.ids.length === 1 ? "Delete forever?" : `Delete ${dialog.ids.length} items forever?`}
          action="Delete forever"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            for (const id of dialog.ids) await purgeItem(folder.id, id);
            setSelected(new Set());
            toast(dialog.ids.length === 1 ? "Deleted forever." : `Deleted ${dialog.ids.length} items forever.`);
          }}
        >
          <p>
            {dialog.ids.length === 1 ? "Its" : "Their"} words, saved text, highlights and notes are deleted from this device
            {folder.repo ? " and from GitHub" : ""}. This can't be undone.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "topics" && (
        <TopicsDialog
          title={`Topics for "${dialog.doc.title}"`}
          intro="Which of the things you're growing in does this belong to?"
          options={topics}
          initial={dialog.doc.topics ?? []}
          onSave={async (chosen) => {
            await setItemTopics(folder.id, dialog.doc.id, chosen);
            // A topic first typed here becomes one of the reader's topics too.
            const added = chosen.filter((t) => !topics.includes(t));
            if (added.length) setHabit({ topics: [...topics, ...added] });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

const label = (k: TypeFilter) => (k === "daily" ? "Daily note" : k ? TYPE_LABELS[k] : "All types");

const EMPTY: Record<View, { title: string; text: string }> = {
  inbox: { title: "Your Inbox is clear", text: "New things you save land here. Archive what you've finished and move the rest to Later." },
  later: { title: "Nothing for later", text: "Press L on an item, or use its menu, to keep it here for another day." },
  archive: { title: "Nothing archived yet", text: "Press E on an item when you're done with it. It stays searchable here." },
  all: { title: "Nothing here", text: "Save a link, a quote or a note, or drop PDFs here." },
  favorites: { title: "No favourites yet", text: "Press S on an item, or use its menu, to keep it here." },
  trash: { title: "The Trash is empty", text: "Items you delete wait here until you delete them for good." },
};

/**
 * One item in the grid. The link opens it; the checkbox and the options button sit beside the
 * link rather than inside it, and the link's name is just the title and one line about it.
 */
function Card({
  folder,
  item,
  position,
  thumb,
  notes,
  videos,
  selected,
  onSelect,
  onMenu,
  onRestore,
  onPurge,
}: {
  folder: string;
  item: Row;
  position?: Position;
  thumb?: string;
  notes: number;
  videos: number;
  selected: boolean;
  onSelect: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const titleId = `card-${item.id}-title`;
  const metaId = `card-${item.id}-meta`;
  const pdf = item.type === "pdf";
  const playlist = item.type === "playlist";
  const reading = !pdf && partlyRead(position) ? position : undefined;
  const pdfProgress = pdf && position && (item.pages ?? 1) > 1 ? (position.page - 1 + position.offset) / item.pages! : 0;
  const host = hostOf(item.sourceUrl);

  const meta = pdf
    ? [
        position ? `p. ${position.page} of ${item.pages} · ${timeAgo(position.updatedAt)}` : `${item.pages ?? "?"} pages · ${formatBytes(item.size ?? 0)}`,
        notes > 0 ? `${notes} note${notes === 1 ? "" : "s"}` : null,
      ]
    : [
        playlist ? null : host,
        playlist
          ? timeAgo(item.addedAt)
          : reading
            ? `${Math.round(reading.offset * 100)}% ${item.type === "video" ? "watched" : "read"} · ${timeAgo(reading.updatedAt)}`
            : timeAgo(item.addedAt),
        notes > 0 ? `${notes} ${item.type === "video" ? "note" : "highlight"}${notes === 1 ? "" : "s"}` : null,
      ];

  const cover = pdf ? (
    <div className="cover">
      {thumb ? (
        <img src={thumb} alt="" loading="lazy" />
      ) : (
        <div className="cover-placeholder" aria-hidden="true">
          <FileText size={28} strokeWidth={1.4} />
          <span>{item.title}</span>
        </div>
      )}
      {pdfProgress > 0 && (
        <div className="progress" title={`Page ${position!.page} of ${item.pages}`}>
          <div style={{ width: `${Math.min(100, pdfProgress * 100)}%` }} />
        </div>
      )}
    </div>
  ) : (
    <div className={`cover cover-item type-${item.type}`} aria-hidden="true">
      {/* A page of the text, on the same paper as a PDF's first page, so the cover reads as finished. */}
      <div className="cover-page">
        <span className="type-pill">{isDailyNote(item) ? "Daily note" : TYPE_LABELS[item.type]}</span>
        {playlist ? (
          <p className="cover-host">{videos === 1 ? "1 video" : `${videos} videos`}</p>
        ) : item.type === "quote" ? (
          <p className="cover-quote">{item.title}</p>
        ) : item.excerpt ? (
          <p className="cover-excerpt">{item.excerpt}</p>
        ) : (
          host && <p className="cover-host">{host}</p>
        )}
      </div>
      {reading && (
        <div className="progress">
          <div style={{ width: `${reading.offset * 100}%` }} />
        </div>
      )}
    </div>
  );

  const info = (
    <div className="doc-info">
      <span className="doc-title" id={titleId} title={item.title}>
        {item.favorite && <Star size={12} className="fav-star" aria-label="Favourite" />}
        {item.title}
      </span>
      <span className="doc-meta" id={metaId}>
        {[pdf ? null : TYPE_LABELS[item.type], ...meta].filter(Boolean).join(" · ")}
      </span>
      {item.topics?.length ? <span className="doc-topics">{item.topics.join(" · ")}</span> : null}
    </div>
  );

  return (
    <li className={`doc-item ${selected ? "selected" : ""}`} data-item={item.id}>
      <input type="checkbox" className="card-select" checked={selected} onChange={onSelect} aria-label={`Select ${item.title}`} />
      {item.deleted ? (
        <div className="doc-card in-trash" tabIndex={0} role="group" aria-labelledby={`${titleId} ${metaId}`} onContextMenu={onMenu}>
          {cover}
          {info}
          <div className="trash-actions">
            <button className="btn btn-small" onClick={onRestore}>
              <RotateCcw size={14} /> Restore
            </button>
            <button className="btn btn-small" onClick={onPurge}>
              Delete forever
            </button>
          </div>
        </div>
      ) : (
        <a className="doc-card" href={itemHref(folder, item)} aria-labelledby={`${titleId} ${metaId}`} onContextMenu={onMenu}>
          {cover}
          {info}
        </a>
      )}
      <button className="icon-btn card-menu" aria-label={`${item.title} options`} onClick={onMenu}>
        <Ellipsis size={16} />
      </button>
    </li>
  );
}

function CopyDialog({ from, doc, onClose }: { from: Folder; doc: Row; onClose: () => void }) {
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const [busy, setBusy] = useState(false);
  const others = folders.filter((f) => f.id !== from.id);
  return (
    <Modal title={`Copy "${doc.title}"`} onClose={onClose}>
      <div className="form">
        <p className="hint">The PDF is copied. Highlights and notes stay in {from.name}. To take them along, move it instead.</p>
        {others.length === 0 ? (
          <p>There are no other folders yet.</p>
        ) : (
          <ul className="pick-list">
            {others.map((f) => (
              <li key={f.id}>
                <button
                  className="nav-item"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const ok = await copyItem(from.id, f.id, doc.id).catch(() => false);
                    toast(ok ? `Copied to ${f.name}.` : "Couldn't copy: the PDF isn't on this device and GitHub can't be reached.");
                    onClose();
                  }}
                >
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** Move items to another folder, with their highlights, notes and reading place. */
export function MoveDialog({
  from,
  items,
  onDone,
  onClose,
}: {
  from: Folder;
  items: Pick<Item, "id" | "title">[];
  /** After the move, with the folder they went to. */
  onDone: (to: Folder) => void;
  onClose: () => void;
}) {
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const [busy, setBusy] = useState(false);
  const others = folders.filter((f) => f.id !== from.id);
  const what = items.length === 1 ? `"${items[0].title}"` : `${items.length} items`;
  return (
    <Modal title={`Move ${what}`} onClose={onClose}>
      <div className="form">
        <p className="hint">Highlights, notes and your place in it go too. It leaves {from.name}.</p>
        {others.length === 0 ? (
          <p>There are no other folders yet. Make one from the folder list first.</p>
        ) : (
          <ul className="pick-list">
            {others.map((f) => (
              <li key={f.id}>
                <button
                  className="nav-item"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    let moved = 0;
                    for (const d of items) if (await moveItem(from.id, f.id, d.id).catch(() => false)) moved++;
                    const failed = items.length - moved;
                    toast(
                      failed
                        ? `Moved ${moved} of ${items.length} to ${f.name}. A PDF that isn't on this device needs GitHub to be reachable.`
                        : `Moved ${items.length === 1 ? "it" : `${items.length} items`} to ${f.name}.`,
                      { action: { label: "Open", run: () => navigate({ name: "library", folder: f.id }) } },
                    );
                    onClose();
                    onDone(f);
                  }}
                >
                  {busy && <LoaderCircle size={14} className="spin" />}
                  <span>{f.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
