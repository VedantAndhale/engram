import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Annotation, Folder, Item } from "../../model";
import { noteFromHighlight } from "../../notes/notes";
import { findQuote, indexText, quoteOf, type TextIndex } from "../../reader/anchor";
import { ArticleBody } from "../../reader/markdown";
import { deleteAnnotation, saveAnnotation, updateAnnotation } from "../../store/actions";
import { navigate, toast } from "../../store/ui";
import { AnnotationPopover, lastColor, SelectionPopover, setLastColor } from "./Popovers";
import { caretAt, useTouchTools, type Surface } from "./touch";

/*
 * A saved article, for reading: the text with your highlights painted in, and selecting text to
 * highlight it, as in the PDF reader. Highlights are painted with the browser's highlight API
 * (CSS.highlights), so the article's elements are never rewritten around them. A highlight
 * whose words aren't in the text any more still shows in the list beside it.
 */

const ARTICLE: Surface = { surface: ".article-text", text: ".article-text" };
const PICKED = "hl-picked";

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
}: {
  folder: Folder;
  item: Item;
  annotations: Annotation[];
  scroller: React.RefObject<HTMLElement | null>;
  highlighter: boolean;
  prefs: ReadingPrefs;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = useRef<TextIndex | null>(null);
  const ranges = useRef(new Map<string, Range>());
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
    return () => names.forEach((n) => CSS.highlights.delete(n));
  }, [highlights, item.content, markdown]);

  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const r = picked && ranges.current.get(picked.id);
    if (r) CSS.highlights.set(PICKED, new Highlight(r));
    else CSS.highlights.delete(PICKED);
    return () => void CSS.highlights.delete(PICKED);
  }, [picked]);

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
        <ArticleBody text={item.content ?? ""} markdown={markdown} />
      </div>

      {selection && (
        <SelectionPopover
          anchor={selection.anchor}
          text={selection.range.toString()}
          onHighlight={(color, withNote) => void highlight(color, selection.range, withNote)}
          onClose={() => setSelection(null)}
        />
      )}
      {picked && pickedAnnotation && (
        <AnnotationPopover
          anchor={picked.anchor}
          annotation={pickedAnnotation}
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
