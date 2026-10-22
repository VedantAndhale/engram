import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QUICK_ACTIONS, type QuickAction } from "../../ai/dialog";
import { addNote, useNotes } from "../../ai/notes";
import { DEFINE_MAX_WORDS, wordCount } from "../../ai/prompts";
import { savedText, sentenceAround } from "../../ai/source";
import { scrollMotion } from "../../lib/util";
import type { Annotation, Folder, Item } from "../../model";
import { noteFromHighlight } from "../../notes/notes";
import { findQuote, indexText, NOT_TEXT, quoteOf, type TextIndex } from "../../reader/anchor";
import { ArticleBody } from "../../reader/markdown";
import { deleteAnnotation, saveAnnotation, updateAnnotation } from "../../store/actions";
import { navigate, toast } from "../../store/ui";
import { NoteCard } from "./NoteCard";
import { AnnotationPopover, lastColor, SelectionPopover, setLastColor } from "./Popovers";
import { caretAt, useTouchTools, type Surface } from "./touch";

/** The article's text, drawn once: a streaming answer must not make the whole article draw again. */
const Body = memo(ArticleBody);

/** The paragraph a range starts in, by the number the article view and the model's citations share. */
function paraOf(range: Range): number {
  const node = range.startContainer;
  const el = node instanceof Element ? node : node.parentElement;
  return Number(el?.closest<HTMLElement>("[data-para]")?.dataset.para) || 1;
}

/** The notes that sit under their paragraphs, drawn into the slots the article leaves for them. */
function InlineNotes({ item, slots }: { item: string; slots: Record<number, HTMLElement> }) {
  const all = useNotes((s) => s.notes);
  const active = useNotes((s) => s.active);
  return (
    <>
      {all
        .filter((n) => n.item === item && slots[n.anchor.para])
        .map((n) => createPortal(<NoteCard note={n} variant="inline" active={active === n.id} />, slots[n.anchor.para], n.id))}
    </>
  );
}

/*
 * A saved article, for reading: the text with your highlights painted in, and selecting text to
 * highlight it, as in the PDF reader. Highlights are painted with the browser's highlight API
 * (CSS.highlights), so the article's elements are never rewritten around them. A highlight
 * whose words aren't in the text any more still shows in the list beside it.
 */

const ARTICLE: Surface = { surface: ".article-text", text: ".article-text" };
const PICKED = "hl-picked";
/** The words an open note is about, painted like a highlight. */
const NOTE_ANCHOR = "note-anchor";
/** How far below the top bar a jump to a highlight stops, so the line isn't pinned under it. */
const JUMP_GAP = 24;

export interface ReadingPrefs {
  size: number;
  wide: boolean;
}

export function ArticleView({
  folder,
  item,
  annotations,
  scroller,
  highlighter,
  prefs,
  ranges,
  onPlaced,
  inlineNotes,
}: {
  folder: Folder;
  item: Item;
  annotations: Annotation[];
  scroller: React.RefObject<HTMLElement | null>;
  highlighter: boolean;
  prefs: ReadingPrefs;
  /** True when the window has no room for a margin: AI notes then sit under their paragraphs. */
  inlineNotes: boolean;
  /** Where each highlight that could be found in the text is painted, by highlight id. */
  ranges: React.RefObject<Map<string, Range>>;
  /** Told the highlight ids in the order they sit in the text, each time they are painted. */
  onPlaced?: (ids: string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = useRef<TextIndex | null>(null);
  const [selection, setSelection] = useState<{ anchor: DOMRect; range: Range } | null>(null);
  const [picked, setPicked] = useState<{ id: string; anchor: DOMRect; edit?: boolean } | null>(null);
  const highlights = useMemo(() => annotations.filter((a) => a.kind === "highlight" && a.quote?.trim() && !a.deleted), [annotations]);
  const markdown = item.contentFormat === "markdown";

  useTouchTools(scroller, highlighter ? "highlight" : "select", true, ARTICLE);

  // Paint every highlight that can be found in the text, one highlight group per colour.
  useLayoutEffect(() => {
    if (!ref.current || !("highlights" in CSS)) return;
    const ix = indexText(ref.current);
    index.current = ix;
    ranges.current.clear();
    const groups = new Map<string, Range[]>();
    for (const a of highlights) {
      const r = findQuote(ix, a);
      if (!r) continue;
      ranges.current.set(a.id, r);
      groups.set(a.color, [...(groups.get(a.color) ?? []), r]);
    }
    const names: string[] = [];
    let css = "";
    [...groups].forEach(([color, rs], i) => {
      const name = `hl-${i}`;
      names.push(name);
      CSS.highlights.set(name, new Highlight(...rs));
      // Colours come from synced files: only a plain hex colour goes into the style sheet.
      const safe = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#f7d154";
      css += `::highlight(${name}){background-color:color-mix(in srgb, ${safe} 50%, transparent)}`;
    });
    styleSheet().textContent = css;
    onPlaced?.([...ranges.current].sort(([, a], [, b]) => a.compareBoundaryPoints(Range.START_TO_START, b)).map(([id]) => id));
    return () => names.forEach((n) => CSS.highlights.delete(n));
  }, [highlights, item.content, markdown]);

  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const r = picked && ranges.current.get(picked.id);
    if (r) CSS.highlights.set(PICKED, new Highlight(r));
    else CSS.highlights.delete(PICKED);
    return () => void CSS.highlights.delete(PICKED);
  }, [picked]);

  // The paragraphs that have a note under them, when notes sit in the text. Only a change in which
  // paragraphs have one draws the article again, not the words streaming into a note.
  const noteParas = useNotes((s) =>
    inlineNotes
      ? s.notes
          .filter((n) => n.item === item.id)
          .map((n) => n.anchor.para)
          .sort((a, b) => a - b)
          .join(",")
      : "",
  );
  const slotParas = useMemo(() => new Set(noteParas ? noteParas.split(",").map(Number) : []), [noteParas]);
  const after = useCallback((n: number) => (slotParas.has(n) ? <div key={`note-${n}`} className="note-slot" data-note="" data-note-slot={n} /> : null), [slotParas]);
  const [slots, setSlots] = useState<Record<number, HTMLElement>>({});
  useLayoutEffect(() => {
    const found: Record<number, HTMLElement> = {};
    ref.current?.querySelectorAll<HTMLElement>("[data-note-slot]").forEach((el) => (found[Number(el.dataset.noteSlot)] = el));
    setSlots(found);
  }, [slotParas, item.content, markdown]);

  // The words the open note is about are painted, or else its whole paragraph is marked.
  const noteAnchor = useNotes((s) => {
    const n = s.notes.find((x) => x.id === s.active && x.item === item.id);
    return n ? JSON.stringify(n.anchor) : "";
  });
  useEffect(() => {
    if (!noteAnchor) return;
    const { para, quote } = JSON.parse(noteAnchor) as { para: number; quote?: string };
    const el = ref.current?.querySelector<HTMLElement>(`[data-para="${para}"]`);
    if (!el || !quote) return;
    const range = "highlights" in CSS ? findQuote(indexText(el), { quote }) : null;
    if (range) CSS.highlights.set(NOTE_ANCHOR, new Highlight(range));
    else el.classList.add("para-noted");
    return () => {
      if ("highlights" in CSS) CSS.highlights.delete(NOTE_ANCHOR);
      el.classList.remove("para-noted");
    };
  }, [noteAnchor]);

  /** Ask the model about a selection: its answer opens as a note beside the passage. */
  const askAbout = (range: Range, action: QuickAction | "ask", question?: string) => {
    const quote = range.toString().replace(/\s+/g, " ").trim();
    if (!quote) return;
    addNote({ item: item.id, action, para: paraOf(range), quote, sentence: sentenceAround(savedText(item), quote), question });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const highlight = useCallback(
    async (color: string, range: Range, askWhy = false) => {
      const ix = index.current;
      const q = ix && quoteOf(ix, range);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      if (!q) return;
      setLastColor(color);
      const rect = range.getBoundingClientRect();
      const a = await saveAnnotation(folder.id, { doc: item.id, kind: "highlight", page: 0, color, ...q });
      if (askWhy) setPicked({ id: a.id, anchor: rect, edit: true });
    },
    [folder.id, item.id],
  );

  // A finished selection: highlight it at once with the highlighter, else offer the colours.
  // A tap on a highlight opens it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onUp = (e: PointerEvent) =>
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          if (!el.contains(range.commonAncestorContainer) || !range.toString().trim()) return;
          // Words selected inside an AI note are for copying, not for highlighting.
          const within = range.commonAncestorContainer;
          if ((within instanceof Element ? within : within.parentElement)?.closest(NOT_TEXT)) return;
          if (highlighter) return void highlight(lastColor(), range);
          const rects = Array.from(range.getClientRects());
          setSelection({ anchor: rects[rects.length - 1] ?? range.getBoundingClientRect(), range });
          return;
        }
        const at = caretAt(e.clientX, e.clientY, ARTICLE.text);
        if (!at) return;
        for (const [id, r] of ranges.current) {
          if (r.isPointInRange(at.node, at.offset)) {
            const box = Array.from(r.getClientRects()).find((b) => b.top <= e.clientY && b.bottom >= e.clientY) ?? r.getBoundingClientRect();
            return setPicked({ id, anchor: box });
          }
        }
      }, 0);
    el.addEventListener("pointerup", onUp);
    return () => el.removeEventListener("pointerup", onUp);
  }, [highlighter, highlight]);

  const pickedAnnotation = picked ? highlights.find((a) => a.id === picked.id) : undefined;

  return (
    <>
      <div
        ref={ref}
        className={`article-text ${highlighter ? "tool-highlight" : ""} ${prefs.wide ? "wide" : ""}`}
        style={{ "--article-size": `${prefs.size}px` } as React.CSSProperties}
      >
        <Body text={item.content ?? ""} markdown={markdown} after={inlineNotes ? after : undefined} />
      </div>
      {inlineNotes && <InlineNotes item={item.id} slots={slots} />}

      {selection && (
        <SelectionPopover
          anchor={selection.anchor}
          text={selection.range.toString()}
          item={item}
          ai={{
            actions: QUICK_ACTIONS.filter((a) => a !== "define" || wordCount(selection.range.toString()) <= DEFINE_MAX_WORDS),
            onAction: (action) => askAbout(selection.range, action),
            onAsk: (question) => askAbout(selection.range, "ask", question),
          }}
          onHighlight={(color, withNote) => void highlight(color, selection.range, withNote)}
          onClose={() => setSelection(null)}
        />
      )}
      {picked && pickedAnnotation && (
        <AnnotationPopover
          anchor={picked.anchor}
          annotation={pickedAnnotation}
          item={item}
          startEditing={picked.edit}
          onChange={(patch) => void updateAnnotation(folder.id, pickedAnnotation.id, patch)}
          onDelete={async () => {
            setPicked(null);
            await deleteAnnotation(folder.id, pickedAnnotation.id);
            toast("Highlight deleted", { action: { label: "Undo", run: () => void updateAnnotation(folder.id, pickedAnnotation.id, { deleted: false }) } });
          }}
          onMakeNote={async () => {
            const note = await noteFromHighlight(folder.id, item, pickedAnnotation.quote!);
            navigate({ name: "item", folder: folder.id, item: note.id });
          }}
          onClose={() => setPicked(null)}
        />
      )}
    </>
  );
}

/** Scrolls the article so a highlight's text sits just under its top bar, which stays over the article's top. */
export function scrollArticleTo(scroller: HTMLElement, range: Range) {
  const bar = scroller.querySelector(".topbar")?.getBoundingClientRect().height ?? 0;
  const top = scroller.scrollTop + range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - bar - JUMP_GAP;
  scroller.scrollTo({ top, behavior: scrollMotion() });
}

/** One style element for the highlight colours, shared by whichever article is open. */
function styleSheet(): HTMLStyleElement {
  let el = document.getElementById("article-highlights") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "article-highlights";
    document.head.append(el);
  }
  return el;
}
