import "../../styles/notes.css";
import { ArrowUp, Copy, GitCompareArrows, NotebookPen, Pin, Sparkles, StickyNote, Trash2 } from "lucide-react";
import { m, useIsPresent, useReducedMotion } from "motion/react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openAi, QUICK_LABEL, type QuickAction } from "../../ai/dialog";
import { savedText, sentenceAround } from "../../ai/source";
import { setHabit, useHabit } from "../../habit/prefs";
import { HIGHLIGHT_COLORS, type Annotation, type Item } from "../../model";
import { citation } from "../../notes/export";
import { Lazy } from "../interior/Lazy";

// The Markdown editor, loaded when a note is first written (as ItemView does), so CodeMirror stays out of the reader's first load.
const Editor = lazy(() => import("../../editor/Editor"));

/** The springs and the 130 ms exit of interior.dev's Popover. */
const POPOVER_SPRING = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;
const POPOVER_EASE = [0.23, 1, 0.32, 1] as const;

/**
 * A small floating panel pinned under (or above, if there's no room) an on-screen rectangle. It grows from
 * the side facing that rectangle, at the middle of it, so it reads as coming from what you selected, and
 * it fades out when its parent lets it (inside AnimatePresence). With reduced motion it only fades.
 */
function Floating({ anchor, onClose, children, label }: { anchor: DOMRect; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; originX: number; originY: number } | null>(null);
  const reduced = useReducedMotion();
  // Leaving: still drawn for a moment, but no longer something to click.
  const present = useIsPresent();

  useLayoutEffect(() => {
    const el = ref.current!;
    // The layout size, which the entry's scale does not change.
    const { offsetWidth: width, offsetHeight: height } = el;
    const margin = 8;
    let top = anchor.bottom + margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, anchor.top - height - margin);
    const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - margin);
    // Where it grows from, as fractions of its own size: the middle of the anchor, on the side that faces it.
    const originX = width > 0 ? Math.min(Math.max(0, (anchor.left + anchor.width / 2 - left) / width), 1) : 0.5;
    setPos({ left, top, originX, originY: top >= anchor.bottom ? 0 : 1 });
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
    <Lazy>
      <m.div
        ref={ref}
        className="popover"
        role="dialog"
        aria-label={label}
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, originX: pos?.originX ?? 0.5, originY: pos?.originY ?? 0, pointerEvents: present ? undefined : "none" }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduced ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, scale: 0.97, transition: { duration: 0.13, ease: POPOVER_EASE } }}
        transition={reduced ? { duration: 0 } : { ...POPOVER_SPRING, opacity: { duration: 0.14, ease: POPOVER_EASE } }}
      >
        {children}
      </m.div>
    </Lazy>
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

/** What the AI offers on a selection beside an article: one-click actions, and a question of your own. */
export interface SelectionAi {
  actions: QuickAction[];
  onAction: (action: QuickAction) => void;
  onAsk: (question: string) => void;
}

/**
 * The question box under a selection. Typing anywhere while the popover is open goes into it, so asking
 * about a passage is: select, then type. The first key is kept, and the item's own shortcuts stay out of it.
 */
function AskBox({ onAsk }: { onAsk: (question: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  // While the popover fades out it must not keep catching keys.
  const present = useIsPresent();
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      e.stopPropagation();
      setQ((v) => v + e.key);
      input.current?.focus();
    };
    // Captured, so the item's one-letter shortcuts (archive, favourite) don't fire on the way.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [present]);
  return (
    <form
      className="popover-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) onAsk(q);
      }}
    >
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this passage" aria-label="Ask about this passage" />
      <button className="icon-btn" type="submit" aria-label="Ask" title="Ask" disabled={!q.trim()}>
        <ArrowUp size={16} />
      </button>
    </form>
  );
}

/** Keep a passage, then compare the next one selected in the same item with it. */
export interface SelectionCompare {
  /** The passage kept in this item, or null. */
  kept: string | null;
  onKeep: () => void;
  onCompare: () => void;
}

/** Shown after selecting text: pick a colour to highlight it, or copy it. With `ai`, it also explains or answers beside the passage. */
export function SelectionPopover({
  anchor,
  text,
  item,
  page,
  ai,
  compare,
  onHighlight,
  onClose,
}: {
  anchor: DOMRect;
  text: string;
  /** With the item, Copy gives a citation; without it, the bare text. */
  item?: Item;
  page?: number;
  ai?: SelectionAi;
  compare?: SelectionCompare;
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
        {!ai && (
          <button
            className="icon-btn"
            title="Explain with AI (on this device)"
            aria-label="Explain with AI"
            onClick={() => {
              openAi({ mode: "explain", title: item?.title ?? "this text", text, context: item ? sentenceAround(savedText(item), text) : "" });
              onClose();
            }}
          >
            <Sparkles size={16} />
          </button>
        )}
        {compare && compare.kept !== text && (
          <button
            className="icon-btn"
            title="Keep this passage to compare it with the next one"
            aria-label="Keep for comparison"
            onClick={() => {
              compare.onKeep();
              onClose();
            }}
          >
            <Pin size={16} />
          </button>
        )}
        {compare?.kept && compare.kept !== text && (
          <button
            className="icon-btn"
            title="Compare with the kept passage"
            aria-label="Compare with the kept passage"
            onClick={() => {
              compare.onCompare();
              onClose();
            }}
          >
            <GitCompareArrows size={16} />
          </button>
        )}
        <button
          className="icon-btn"
          title="Copy with citation"
          onClick={() => {
            // A selection has no highlight yet, so it is cited as the highlight it would become.
            const cited = item ? citation(item, { id: "", doc: item.id, kind: "highlight", page: page ?? 0, color: "", quote: text, createdAt: 0, updatedAt: 0 }) : text;
            void navigator.clipboard?.writeText(cited);
            onClose();
          }}
        >
          <Copy size={16} />
        </button>
      </div>
      {ai && (
        <div className="popover-ai">
          <div className="popover-actions">
            {ai.actions.map((a) => (
              <button key={a} className="btn" onClick={() => ai.onAction(a)}>
                {QUICK_LABEL[a]}
              </button>
            ))}
          </div>
          <AskBox onAsk={ai.onAsk} />
        </div>
      )}
    </Floating>
  );
}

/** Shown when tapping an existing highlight: recolour, write a note, make it a note of its own, or delete. */
export function AnnotationPopover({
  anchor,
  annotation,
  item,
  startEditing,
  onChange,
  onDelete,
  onMakeNote,
  onClose,
}: {
  anchor: DOMRect;
  annotation: Annotation;
  /** With the item, Copy gives a citation; without it, the bare quote. */
  item?: Item;
  startEditing?: boolean;
  onChange: (patch: Partial<Annotation>) => void;
  onDelete: () => void;
  onMakeNote?: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(annotation.note ?? "");
  const [editing, setEditing] = useState(startEditing || !!annotation.note);
  const saved = useRef(annotation.note ?? "");
  const coachDone = useHabit((h) => h.coachDone);

  // Save the note as it's typed (debounced) and once more on close, so nothing is lost.
  useEffect(() => {
    if (note === saved.current) return;
    const t = setTimeout(() => {
      saved.current = note;
      onChange({ note: note.trim() ? note : undefined });
      // Once they've written a line of their own, the tip has done its job.
      if (note.trim()) setHabit({ coachDone: true });
    }, 600);
    return () => clearTimeout(t);
  }, [note, onChange]);

  const close = () => {
    if (note !== saved.current) onChange({ note: note.trim() ? note : undefined });
    if (note.trim()) setHabit({ coachDone: true });
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
        {onMakeNote && !!annotation.quote?.trim() && (
          <button
            className="icon-btn"
            title="Make a note from this"
            onClick={() => {
              if (note !== saved.current) onChange({ note: note.trim() ? note : undefined });
              onMakeNote();
            }}
          >
            <NotebookPen size={16} />
          </button>
        )}
        {!!annotation.quote?.trim() && (
          <button
            className="icon-btn"
            title="Copy with citation"
            onClick={() => {
              void navigator.clipboard?.writeText(item ? citation(item, annotation) : (annotation.quote ?? ""));
              close();
            }}
          >
            <Copy size={16} />
          </button>
        )}
        <button className="icon-btn danger" title="Delete highlight" onClick={onDelete}>
          <Trash2 size={16} />
        </button>
      </div>
      {editing && !coachDone && !annotation.note && (
        <p className="note-coach">One line on why this matters to you. It's what you'll see again when you review, and no chatbot can write it for you.</p>
      )}
      {editing && (
        <div
          className="note-editor note-editor-popover"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) close();
          }}
        >
          <Suspense fallback={<div className="md-editor md-loading" />}>
            <Editor
              value={note}
              onChange={setNote}
              titles={() => []}
              openWiki={() => {}}
              highlights={async () => []}
              embed={async () => null}
              autoFocus
              placeholder={annotation.note ? "Write a note…" : "Why does this matter? (optional)"}
            />
          </Suspense>
        </div>
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
