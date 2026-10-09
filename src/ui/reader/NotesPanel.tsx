import { Download, PenLine, X } from "lucide-react";
import { useMemo, useState } from "react";
import { timeAgo } from "../../lib/util";
import type { Annotation } from "../../model";

type Filter = "all" | "notes" | "ink";

export function NotesPanel({
  title,
  annotations,
  me,
  onJump,
  onClose,
}: {
  title: string;
  annotations: Annotation[];
  me?: string;
  onJump: (a: Annotation) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(
    () =>
      annotations
        .filter((a) => (filter === "notes" ? !!a.note : filter === "ink" ? a.kind === "ink" : true))
        .sort((a, b) => a.page - b.page || (a.rects?.[0]?.y ?? 0) - (b.rects?.[0]?.y ?? 0) || a.createdAt - b.createdAt),
    [annotations, filter],
  );

  return (
    <aside className="notes-panel" aria-label="Highlights and notes">
      <header className="notes-head">
        <h2>Notes</h2>
        <div className="spacer" />
        <button className="icon-btn" title="Export as Markdown" disabled={!annotations.length} onClick={() => exportMarkdown(title, annotations)}>
          <Download size={16} />
        </button>
        <button className="icon-btn" aria-label="Close notes" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="seg" role="tablist">
        {(["all", "notes", "ink"] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "notes" ? "With notes" : "Drawings"}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="notes-empty">
          {annotations.length ? "Nothing matches this filter." : "Select text to highlight it. Your highlights and notes will show up here."}
        </p>
      ) : (
        <ol className="notes-list">
          {list.map((a) => (
            <li key={a.id}>
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
                    Page {a.page}
                    {a.author && a.author !== me ? ` · ${a.author}` : ""} · {timeAgo(a.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function exportMarkdown(title: string, annotations: Annotation[]) {
  const lines = [`# ${title}`, ""];
  const sorted = annotations.filter((a) => a.kind === "highlight").sort((a, b) => a.page - b.page || (a.rects?.[0]?.y ?? 0) - (b.rects?.[0]?.y ?? 0));
  for (const a of sorted) {
    lines.push(`> ${(a.quote ?? "").replace(/\s+/g, " ").trim()}`, "");
    if (a.note) lines.push(a.note, "");
    lines.push(`— page ${a.page}`, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "notes"}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
