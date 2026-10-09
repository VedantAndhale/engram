import { Copy, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HIGHLIGHT_COLORS, type Annotation } from "../../model";

/** A small floating panel pinned under (or above, if there's no room) an on-screen rectangle. */
function Floating({ anchor, onClose, children, label }: { anchor: DOMRect; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let top = anchor.bottom + margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, anchor.top - height - margin);
    const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - margin);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer so the click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="popover" role="dialog" aria-label={label} style={pos ?? { left: -9999, top: -9999 }}>
      {children}
    </div>
  );
}

function Swatches({ value, onPick }: { value?: string; onPick: (color: string) => void }) {
  return (
    <div className="swatches">
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.id}
          className={`swatch ${value === c.value ? "on" : ""}`}
          style={{ background: c.value }}
          aria-label={`Highlight ${c.label.toLowerCase()}`}
          aria-pressed={value === c.value}
          onClick={() => onPick(c.value)}
        />
      ))}
    </div>
  );
}

/** Shown after selecting text: pick a colour to highlight it, or copy it. */
export function SelectionPopover({
  anchor,
  text,
  onHighlight,
  onClose,
}: {
  anchor: DOMRect;
  text: string;
  onHighlight: (color: string, withNote: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Floating anchor={anchor} onClose={onClose} label="Selection">
      <div className="popover-row">
        <Swatches onPick={(c) => onHighlight(c, false)} />
        <span className="popover-sep" />
        <button className="icon-btn" title="Highlight and add a note" onClick={() => onHighlight(lastColor(), true)}>
          <StickyNote size={16} />
        </button>
        <button
          className="icon-btn"
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            onClose();
          }}
        >
          <Copy size={16} />
        </button>
      </div>
    </Floating>
  );
}

/** Shown when tapping an existing highlight: recolour, write a note, or delete. */
export function AnnotationPopover({
  anchor,
  annotation,
  startEditing,
  onChange,
  onDelete,
  onClose,
}: {
  anchor: DOMRect;
  annotation: Annotation;
  startEditing?: boolean;
  onChange: (patch: Partial<Annotation>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(annotation.note ?? "");
  const [editing, setEditing] = useState(startEditing || !!annotation.note);
  const saved = useRef(annotation.note ?? "");

  // Save the note as it's typed (debounced) and once more on close, so nothing is lost.
  useEffect(() => {
    if (note === saved.current) return;
    const t = setTimeout(() => {
      saved.current = note;
      onChange({ note: note.trim() ? note : undefined });
    }, 600);
    return () => clearTimeout(t);
  }, [note, onChange]);

  const close = () => {
    if (note !== saved.current) onChange({ note: note.trim() ? note : undefined });
    onClose();
  };

  return (
    <Floating anchor={anchor} onClose={close} label="Highlight">
      <div className="popover-row">
        <Swatches
          value={annotation.color}
          onPick={(color) => {
            setLastColor(color);
            onChange({ color });
          }}
        />
        <span className="popover-sep" />
        {!editing && (
          <button className="icon-btn" title="Add a note" onClick={() => setEditing(true)}>
            <StickyNote size={16} />
          </button>
        )}
        <button className="icon-btn danger" title="Delete highlight" onClick={onDelete}>
          <Trash2 size={16} />
        </button>
      </div>
      {editing && (
        <textarea
          className="note-input"
          autoFocus
          rows={3}
          placeholder="Write a note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) close();
          }}
        />
      )}
    </Floating>
  );
}

export function lastColor(): string {
  return localStorage.getItem("reader.hl") ?? HIGHLIGHT_COLORS[0].value;
}
export function setLastColor(color: string) {
  localStorage.setItem("reader.hl", color);
}
