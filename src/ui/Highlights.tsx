import { useLiveQuery } from "dexie-react-hooks";
import { Copy, Download, Highlighter, Menu as MenuIcon, Plus } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { itemHref, TYPE_LABELS } from "../capture/capture";
import { folderCtx, visibleFolders } from "../folders/registry";
import { type Annotation, HIGHLIGHT_COLORS, ITEM_TYPES, type Folder, type Item, type ItemType } from "../model";
import { citation, downloadMarkdown, markdownFilename } from "../notes/export";
import { navigate, openQuickAdd, toast } from "../store/ui";
import "../styles/highlights.css";

/** One highlight, with the item it sits on and the folder that item is in. */
interface Row {
  folder: Folder;
  item: Item;
  mark: Annotation;
}

/** Every live highlight with a quote, across all visible folders, newest first. */
async function allHighlights(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const folder of await visibleFolders()) {
    const { db } = folderCtx(folder.id);
    const items = new Map((await db.items.toArray()).filter((i) => !i.deleted).map((i) => [i.id, i]));
    for (const mark of await db.annotations.toArray()) {
      const item = items.get(mark.doc);
      if (item && !mark.deleted && mark.kind === "highlight" && mark.quote?.trim()) rows.push({ folder, item, mark });
    }
  }
  return rows.sort((a, b) => b.mark.createdAt - a.mark.createdAt);
}

const count = (n: number) => `${n} highlight${n === 1 ? "" : "s"}`;

/** The library-wide highlights page: every quote you kept, across folders, filtered and exportable. */
export function Highlights({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const rows = useLiveQuery(allHighlights, []);
  const [words, setWords] = useState("");
  const [topic, setTopic] = useState("");
  const [type, setType] = useState<ItemType | "">("");
  const [color, setColor] = useState("");

  if (!rows) return <main className="highlights" />;

  const topics = [...new Set(rows.flatMap((r) => r.item.topics ?? []))].sort((a, b) => a.localeCompare(b));
  const types = ITEM_TYPES.filter((t) => rows.some((r) => r.item.type === t));
  // A filter whose topic or type has no highlights left is ignored, so it can't hide everything without showing why.
  const activeTopic = topic && topics.includes(topic) ? topic : "";
  const activeType = type && types.includes(type) ? type : "";
  const needles = words.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => {
    if (activeTopic && !r.item.topics?.includes(activeTopic)) return false;
    if (activeType && r.item.type !== activeType) return false;
    if (color && r.mark.color !== color) return false;
    const hay = `${r.mark.quote ?? ""} ${r.mark.note ?? ""}`.toLowerCase();
    return needles.every((n) => hay.includes(n));
  });

  // Each highlight is its citation, then your note on it, the same layout a whole item exports to.
  const markdown = shown
    .map((r) => {
      const note = r.mark.note?.trim();
      return [citation(r.item, r.mark), note && `Note: ${note}`].filter(Boolean).join("\n\n");
    })
    .join("\n\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast(`Copied ${count(shown.length)}.`);
    } catch {
      toast("Couldn't copy. Your browser blocked the clipboard.");
    }
  };

  const download = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadMarkdown(markdownFilename(`Highlights ${activeTopic ? `${activeTopic} ` : ""}${stamp}`), `${markdown}\n`);
  };

  const clear = () => {
    setWords("");
    setTopic("");
    setType("");
    setColor("");
  };

  return (
    <main className="highlights">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <h1>Highlights</h1>
        <div className="spacer" />
        {rows.length > 0 && (
          <>
            <button className="btn" disabled={!shown.length} onClick={copy}>
              <Copy size={16} /> <span className="hide-narrow">Copy</span>
            </button>
            <button className="btn" disabled={!shown.length} onClick={download}>
              <Download size={16} /> <span className="hide-narrow">Download</span>
            </button>
          </>
        )}
      </header>

      {rows.length === 0 ? (
        <div className="empty">
          <Highlighter size={40} strokeWidth={1.4} />
          <h2>No highlights yet</h2>
          <p>Select a passage in an article or a PDF and pick a colour. Every highlight shows up here with its source.</p>
          <p>Each one comes back for review a day later, so it sticks.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => navigate({ name: "library" })}>
              Go to your library
            </button>
            <button className="btn" onClick={() => openQuickAdd()}>
              <Plus size={16} /> Save something new
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="hl-filters">
            <input
              type="search"
              className="hl-search"
              value={words}
              placeholder="Find in quotes and notes"
              aria-label="Find in quotes and notes"
              onChange={(e) => setWords(e.target.value)}
            />
            {topics.length > 0 && (
              <select className="select" value={activeTopic} aria-label="Topic" onChange={(e) => setTopic(e.target.value)}>
                <option value="">All topics</option>
                {topics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            <select className="select" value={activeType} aria-label="Item type" onChange={(e) => setType(e.target.value as ItemType | "")}>
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <div className="swatches" role="group" aria-label="Colour">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={`swatch ${color === c.value ? "on" : ""}`}
                  style={{ background: c.value }}
                  title={c.label}
                  aria-label={`${c.label} highlights`}
                  aria-pressed={color === c.value}
                  onClick={() => setColor(color === c.value ? "" : c.value)}
                />
              ))}
            </div>
          </div>

          <p className="hl-count">{shown.length === rows.length ? count(rows.length) : `${shown.length} of ${count(rows.length)}`}</p>

          {shown.length === 0 ? (
            <div className="empty">
              <h2>Nothing matches</h2>
              <p>No highlight has all of these filters.</p>
              <button className="btn" onClick={clear}>
                Clear filters
              </button>
            </div>
          ) : (
            <ul className="hl-list">
              {shown.map((r) => (
                <li key={`${r.folder.id}:${r.mark.id}`}>
                  <a className="hl-card" href={itemHref(r.folder.id, r.item, r.mark.page)} style={{ "--hl": r.mark.color } as CSSProperties}>
                    <blockquote className="hl-quote">{r.mark.quote}</blockquote>
                    {r.mark.note?.trim() && <p className="hl-note">{r.mark.note.trim()}</p>}
                    <div className="hl-meta">
                      <span className="hl-source" title={r.item.title}>
                        {r.item.title}
                      </span>
                      <span>{r.folder.name}</span>
                      <span>
                        {TYPE_LABELS[r.item.type]}
                        {r.mark.page > 0 && ` · p. ${r.mark.page}`}
                      </span>
                      <span>{new Date(r.mark.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
