import { Download, PenLine, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { timeAgo } from "../../lib/util";
import type { Annotation, Item } from "../../model";
import { downloadMarkdown, itemToMarkdown, markdownFilename } from "../../notes/export";
import type { OutlineEntry } from "../../reader/outline";
import "../../styles/reader.css";

export type PanelTab = "contents" | "all" | "notes" | "ink";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "contents", label: "Contents" },
  { id: "all", label: "All" },
  { id: "notes", label: "With notes" },
  { id: "ink", label: "Drawings" },
];

const NO_OUTLINE: OutlineEntry[] = [];
const NO_ORDER: string[] = [];

export function NotesPanel({
  item,
  annotations,
  outline = NO_OUTLINE,
  drawings = true,
  documentOrder = NO_ORDER,
  tab,
  onTab,
  me,
  onJump,
  onPage,
  onDelete,
  onClose,
}: {
  item?: Item;
  annotations: Annotation[];
  /** A PDF's table of contents. An article has none here: its contents are the rail beside the text. */
  outline?: OutlineEntry[];
  /** Whether this document can have drawings. Only PDFs take the pen. */
  drawings?: boolean;
  /** Highlight ids in the order they sit in an article's text. Any not in it follow, oldest first. */
  documentOrder?: string[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  me?: string;
  onJump: (a: Annotation) => void;
  /** Goes to a page from the table of contents. */
  onPage?: (page: number) => void;
  /** Deletes a highlight or drawing, with its note. The caller offers undo. */
  onDelete: (a: Annotation) => void;
  onClose: () => void;
}) {
  // A PDF with no table of contents has no Contents tab at all.
  const tabs = TABS.filter((t) => (t.id !== "contents" || outline.length > 0) && (t.id !== "ink" || drawings));
  const position = useMemo(() => new Map(documentOrder.map((id, i): [string, number] => [id, i])), [documentOrder]);
  const list = useMemo(
    () =>
      annotations
        .filter((a) => (tab === "notes" ? !!a.note : tab === "ink" ? a.kind === "ink" : true))
        .sort(
          (a, b) =>
            a.page - b.page ||
            (a.rects?.[0]?.y ?? 0) - (b.rects?.[0]?.y ?? 0) ||
            (position.get(a.id) ?? documentOrder.length) - (position.get(b.id) ?? documentOrder.length) ||
            a.createdAt - b.createdAt,
        ),
    [annotations, tab, position, documentOrder.length],
  );

  const exportMarkdown = () => {
    if (item) downloadMarkdown(markdownFilename(item.title), itemToMarkdown(item, annotations));
  };

  return (
    <aside className="notes-panel" aria-label="Contents, highlights and notes">
      <header className="notes-head">
        <h2>Notes</h2>
        <div className="spacer" />
        <button className="icon-btn" title="Export as Markdown" disabled={!item || !annotations.length} onClick={exportMarkdown}>
          <Download size={16} />
        </button>
        <button className="icon-btn" aria-label="Close notes" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="seg" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "contents" ? (
        <ol className="notes-list">
          {outline.map((e, i) => (
            <li key={i}>
              <button className="contents-item" style={{ "--depth": e.depth } as React.CSSProperties} onClick={() => onPage?.(e.page)}>
                <span className="contents-title">{e.title}</span>
                <span className="contents-page">{e.page}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : list.length === 0 ? (
        <p className="notes-empty">
          {annotations.length ? "Nothing matches this filter." : "Select text to highlight it. Your highlights and notes will show up here."}
        </p>
      ) : (
        <ol className="notes-list">
          {list.map((a) => (
            <li key={a.id} className="note-row">
              <button className="note-item" onClick={() => onJump(a)}>
                <span className="note-bar" style={{ background: a.color }} />
                <span className="note-body">
                  {a.kind === "ink" ? (
                    <span className="note-quote muted">
                      <PenLine size={14} /> Drawing
                    </span>
                  ) : (
                    <span className="note-quote">{a.quote}</span>
                  )}
                  {a.note && <span className="note-text">{a.note}</span>}
                  <span className="note-meta">
                    {/* Articles keep their highlights on page 0: they have no pages to name. */}
                    {[a.page > 0 && `Page ${a.page}`, a.author && a.author !== me && a.author, timeAgo(a.updatedAt)].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
              <button
                className="icon-btn note-delete"
                aria-label={a.kind === "ink" ? "Delete drawing" : "Delete highlight and note"}
                title={a.kind === "ink" ? "Delete drawing" : "Delete highlight and note"}
                onClick={() => onDelete(a)}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
