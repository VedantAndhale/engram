import { useLiveQuery } from "dexie-react-hooks";
import { Copy, Ellipsis, FileText, LoaderCircle, Menu as MenuIcon, NotebookPen, Pencil, Plus, Tag, Trash2, Upload } from "lucide-react";
import { hostOf, itemHref, titleFromText, TYPE_LABELS } from "../capture/capture";
import { useEffect, useRef, useState } from "react";
import { folderCtx, renameFolder, setAttention, visibleFolders } from "../folders/registry";
import { formatBytes, timeAgo } from "../lib/util";
import type { Item, Folder, Position } from "../model";
import { partlyRead } from "../reader/articlePosition";
import { addPdf, copyItem, removeItem, restoreItem, setItemTopics } from "../store/actions";
import { renameWithLinks } from "../notes/notes";
import { setHabit, useHabit } from "../habit/prefs";
import { TopicsDialog } from "./habit";
import { navigate, openQuickAdd, rememberFolder, toast } from "../store/ui";
import { useAccount } from "../sync/account";
import { Modal, PrivateBadge, PromptDialog, SyncBadge, useFolderSync, useMenu } from "./common";
import "../styles/library.css";

type Sort = "recent" | "added" | "title";

export function Library({ folder, onOpenSidebar }: { folder: Folder; onOpenSidebar: () => void }) {
  const { db, sync } = folderCtx(folder.id);
  const s = useFolderSync(folder.id);
  const account = useAccount((a) => a.account);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem("reader.sort") as Sort) ?? "recent");
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "rename" | "copy" | "topics"; doc: Item } | { kind: "renameFolder" } | null>(null);
  const topics = useHabit((h) => h.topics);
  const [adding, setAdding] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const menu = useMenu();

  useEffect(() => {
    rememberFolder(folder.id);
    setAttention(folder.id, "open");
  }, [folder.id]);

  const docs = useLiveQuery(() => db.items.filter((d) => !d.deleted).toArray(), [db]);
  const positions = useLiveQuery(async () => new Map((await db.positions.toArray()).map((p) => [p.doc, p])), [db]);
  const thumbs = useLiveQuery(async () => new Map((await db.thumbs.toArray()).map((t) => [t.hash, t.dataUrl])), [db]);
  const notes = useLiveQuery(async () => {
    const counts = new Map<string, number>();
    await db.annotations.each((a) => {
      if (!a.deleted) counts.set(a.doc, (counts.get(a.doc) ?? 0) + 1);
    });
    return counts;
  }, [db]);

  const sorted = [...(docs ?? [])].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "added") return b.addedAt - a.addedAt;
    const ra = positions?.get(a.id)?.updatedAt ?? a.addedAt;
    const rb = positions?.get(b.id)?.updatedAt ?? b.addedAt;
    return rb - ra;
  });

  // Topics in use, most used first. A topic that no longer appears on any item drops the filter.
  const topicCounts = new Map<string, number>();
  for (const d of docs ?? []) for (const t of d.topics ?? []) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  const topicList = [...topicCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const activeTopic = topicFilter && topicCounts.has(topicFilter) ? topicFilter : null;
  const shown = activeTopic ? sorted.filter((d) => d.topics?.includes(activeTopic)) : sorted;

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

  // Accept PDFs dropped anywhere on the window while the library is open.
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
      void addFiles(e.dataTransfer!.files);
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
  });

  const docMenu = (e: React.MouseEvent, d: Item) =>
    menu.open(e, [
      { label: "Rename", icon: <Pencil size={15} />, run: () => setDialog({ kind: "rename", doc: d }) },
      { label: "Topics", icon: <Tag size={15} />, run: () => setDialog({ kind: "topics", doc: d }) },
      // A PDF's notes live on the PDF, so they are reached from it rather than listed as items.
      ...(d.type === "pdf" && (notes?.get(d.id) ?? 0) > 0
        ? [{ label: "View notes", icon: <NotebookPen size={15} />, run: () => navigate({ name: "reader", folder: folder.id, doc: d.id, panel: "notes" }) }]
        : []),
      ...(d.type === "pdf" ? [{ label: "Copy to another folder", icon: <Copy size={15} />, run: () => setDialog({ kind: "copy", doc: d }) }] : []),
      {
        label: "Remove",
        icon: <Trash2 size={15} />,
        danger: true,
        run: async () => {
          await removeItem(folder.id, d.id);
          toast(`Removed "${d.title}".`, { action: { label: "Undo", run: () => void restoreItem(folder.id, d.id) } });
        },
      },
    ]);

  return (
    <main className="library">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <button className="folder-title" title="Rename folder" onClick={() => setDialog({ kind: "renameFolder" })}>
          <h1>{folder.name}</h1>
        </button>
        {folder.repo && <PrivateBadge isPrivate={folder.isPrivate} />}
        <div className="spacer" />
        <SyncBadge s={s} onClick={() => (account ? void sync.flush() : navigate({ name: "setup" }))} />
        <select className="select" value={sort} aria-label="Sort by" title="Sort by" onChange={(e) => {
          setSort(e.target.value as Sort);
          localStorage.setItem("reader.sort", e.target.value);
        }}>
          <option value="recent">Last read</option>
          <option value="added">Newest</option>
          <option value="title">A–Z</option>
        </select>
        <button className="btn" onClick={() => fileInput.current?.click()}>
          <Upload size={16} /> <span className="hide-narrow">Add PDF</span>
        </button>
        <button className="btn btn-primary" title="Save a link, a quote or a note (N)" onClick={() => openQuickAdd({ folder: folder.id })}>
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
        </div>
      )}
      {folder.isPrivate === false && (
        <div className="banner banner-warn">
          This folder's repository is public. Anyone can see its PDFs and notes. Make it private on GitHub.
        </div>
      )}

      {adding > 0 && (
        <div className="banner">
          <LoaderCircle size={14} className="spin" /> Adding {adding} PDF{adding === 1 ? "" : "s"}…
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

      {docs && sorted.length === 0 ? (
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
      ) : (
        <ul className="doc-grid">
          {shown.map((d) => {
            if (d.type !== "pdf")
              return <ItemCard key={d.id} folder={folder.id} item={d} position={positions?.get(d.id)} notes={notes?.get(d.id) ?? 0} onMenu={(e) => docMenu(e, d)} />;
            const pos = positions?.get(d.id);
            const progress = pos && (d.pages ?? 1) > 1 ? (pos.page - 1 + pos.offset) / d.pages! : 0;
            const n = notes?.get(d.id) ?? 0;
            return (
              <li key={d.id}>
                <a
                  className="doc-card"
                  href={`#/f/${folder.id}/doc/${d.id}`}
                  onContextMenu={(e) => docMenu(e, d)}
                >
                  <div className="cover">
                    {thumbs?.get(d.id) ? (
                      <img src={thumbs.get(d.id)} alt="" loading="lazy" />
                    ) : (
                      <div className="cover-placeholder">
                        <FileText size={28} strokeWidth={1.4} />
                        <span>{d.title}</span>
                      </div>
                    )}
                    {progress > 0 && (
                      <div className="progress" title={`Page ${pos!.page} of ${d.pages}`}>
                        <div style={{ width: `${Math.min(100, progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="doc-info">
                    <span className="doc-title" title={d.title}>
                      {d.title}
                    </span>
                    <span className="doc-meta">
                      {pos ? `p. ${pos.page} of ${d.pages} · ${timeAgo(pos.updatedAt)}` : `${d.pages ?? "?"} pages · ${formatBytes(d.size ?? 0)}`}
                      {n > 0 && ` · ${n} note${n === 1 ? "" : "s"}`}
                    </span>
                    {d.topics?.length ? <span className="doc-topics">{d.topics.join(" · ")}</span> : null}
                  </div>
                  <button className="icon-btn card-menu" aria-label={`${d.title} options`} onClick={(e) => docMenu(e, d)}>
                    <Ellipsis size={16} />
                  </button>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {dragging && (
        <div className="drop-overlay">
          <Upload size={32} />
          <span>Drop PDFs to add them to {folder.name}</span>
        </div>
      )}

      {menu.node}

      {dialog?.kind === "rename" && (
        <PromptDialog
          title="Rename document"
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
      {dialog?.kind === "copy" && <CopyDialog from={folder} doc={dialog.doc} onClose={() => setDialog(null)} />}
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

/** A card for anything that isn't a PDF: its type, a few lines of it, and where it's from. */
function ItemCard({ folder, item, position, notes, onMenu }: { folder: string; item: Item; position?: Position; notes: number; onMenu: (e: React.MouseEvent) => void }) {
  let text = (item.type === "note" ? item.body : (item.content ?? item.body)) ?? "";
  // A note's first line is already its title.
  if (item.type === "note" && titleFromText(text) === item.title) text = text.trim().split(/\r?\n/).slice(1).join(" ");
  // Formatted articles: images go, links keep their words.
  if (item.type !== "note" && item.contentFormat === "markdown") {
    text = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\\(.)/g, "$1");
  }
  const excerpt = text.replace(/[#>*_`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 220);
  const host = hostOf(item.sourceUrl);
  const reading = partlyRead(position) ? position : undefined;
  return (
    <li>
      <a className="doc-card" href={itemHref(folder, item)} onContextMenu={onMenu}>
        <div className={`cover cover-item type-${item.type}`}>
          <span className="type-pill">{TYPE_LABELS[item.type]}</span>
          {item.type === "quote" ? (
            <p className="cover-quote">{item.title}</p>
          ) : excerpt ? (
            <p className="cover-excerpt">{excerpt}</p>
          ) : (
            host && <p className="cover-host">{host}</p>
          )}
          {reading && (
            <div className="progress" title={`${Math.round(reading.offset * 100)}% read`}>
              <div style={{ width: `${reading.offset * 100}%` }} />
            </div>
          )}
        </div>
        <div className="doc-info">
          <span className="doc-title" title={item.title}>
            {item.title}
          </span>
          <span className="doc-meta">
            {[hostOf(item.sourceUrl), reading ? `${Math.round(reading.offset * 100)}% read · ${timeAgo(reading.updatedAt)}` : timeAgo(item.addedAt)]
              .filter(Boolean)
              .join(" · ")}
            {notes > 0 && ` · ${notes} highlight${notes === 1 ? "" : "s"}`}
          </span>
          {item.topics?.length ? <span className="doc-topics">{item.topics.join(" · ")}</span> : null}
        </div>
        <button className="icon-btn card-menu" aria-label={`${item.title} options`} onClick={onMenu}>
          <Ellipsis size={16} />
        </button>
      </a>
    </li>
  );
}

function CopyDialog({ from, doc, onClose }: { from: Folder; doc: Item; onClose: () => void }) {
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const [busy, setBusy] = useState(false);
  const others = folders.filter((f) => f.id !== from.id);
  return (
    <Modal title={`Copy "${doc.title}"`} onClose={onClose}>
      <div className="form">
        <p className="hint">The PDF is copied. Highlights and notes stay in {from.name}.</p>
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
