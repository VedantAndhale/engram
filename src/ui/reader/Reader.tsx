import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Eraser,
  Highlighter,
  ListTree,
  MousePointer2,
  NotebookPen,
  PenLine,
  Search as SearchIcon,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { folderCtx, setAttention } from "../../folders/registry";
import { openPdf, type PDFDoc } from "../../lib/pdf";
import { clamp, scrollMotion } from "../../lib/util";
import { INK_COLORS, type Annotation, type Folder } from "../../model";
import { snapRange } from "../../reader/anchor";
import { selectionParts, type PagePart } from "../../reader/geometry";
import { loadOutline, type OutlineEntry } from "../../reader/outline";
import { rectsForQuoteAcross } from "../../reader/quoteRects";
import { REFLOW_VERSION, reflowFor, type Reflow } from "../../reader/reflow";
import { deleteAnnotation, ensureThumb, indexDocument, loadPdfData, saveAnnotation, savePosition, updateAnnotation } from "../../store/actions";
import { navigate, toast } from "../../store/ui";
import { useAccount } from "../../sync/account";
import { SyncBadge, useFolderSync } from "../common";
import { NotesPanel, type PanelTab } from "./NotesPanel";
import { PageView, type PageSize, type Tool } from "./PageView";
import { AnnotationPopover, lastColor, SelectionPopover, setLastColor } from "./Popovers";
import { ReflowView, REFLOW_SURFACE, readingBlockAt, readingBlockOnPage, scrollReadingTo, type ReflowSelection } from "./ReflowView";
import { useTouchTools } from "./touch";

const GAP = 16;
const PAD = 16;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Fit-to-width stops growing past this, so lines stay readable on wide screens. */
const MAX_FIT_WIDTH = 980;
/** The reading view's text size at 100% zoom, in px: the size of a saved article. */
const READING_SIZE = 18;

type Load =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; pdf: PDFDoc; sizes: PageSize[]; outline: OutlineEntry[] };

export function Reader({
  folder,
  doc,
  page: startPage,
  find: startFind,
  startPanel,
}: {
  folder: Folder;
  doc: string;
  page?: number;
  find?: string;
  /** Opens the notes panel on its "With notes" tab, e.g. from a PDF's options menu. */
  startPanel?: "notes";
}) {
  const { db } = folderCtx(folder.id);
  const { account } = useAccount();
  const syncState = useFolderSync(folder.id);
  const meta = useLiveQuery(() => db.items.get(doc), [doc]);
  const annotations = useLiveQuery(async () => (await db.annotations.where("doc").equals(doc).toArray()).filter((a) => !a.deleted), [doc]) ?? [];
  const peers = useLiveQuery(async () => (await db.peers.where("doc").equals(doc).toArray()).filter((p) => p.user !== account?.login), [doc, account?.login]) ?? [];

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [view, setView] = useState({ top: 0, height: 0 });
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem("reader.zoom")) || 1);
  const [tool, setTool] = useState<Tool>("select");
  const [inkColor, setInkColor] = useState(() => localStorage.getItem("reader.ink") ?? INK_COLORS[0]);
  const inkSize = 4;
  const [panel, setPanel] = useState(() => !!startPanel || (localStorage.getItem("reader.panel") === "1" && window.innerWidth > 900));
  const [panelTab, setPanelTab] = useState<PanelTab>(startPanel ? "notes" : "all");
  const [findOpen, setFindOpen] = useState(!!startFind);
  const [findText, setFindText] = useState(startFind ?? "");
  const [selection, setSelection] = useState<{ anchor: DOMRect; text: string; parts: Map<number, PagePart> } | null>(null);
  const [picked, setPicked] = useState<{ id: string; anchor: DOMRect; edit?: boolean } | null>(null);
  // The reading view is the default; a reader who chose Page keeps it. The place left in the reading view is
  // kept on this device, and a reader who has one goes back to it, since the text is already in the cache.
  const prefersReading = useRef(localStorage.getItem("reader.view") !== "page");
  const [reading, setReading] = useState(() => prefersReading.current && !startFind && !!readPlace(doc));
  // Pages stay on screen only until the reading view can take over, or while find or the pen is open.
  const autoPage = useRef(prefersReading.current && !startFind && !readPlace(doc));
  /** While the pages are up only until the text is ready, before any switch. A reader who starts reading them stays. */
  const opening = useRef(autoPage.current);
  const [reflow, setReflow] = useState<Reflow | null>(null);
  const [prep, setPrep] = useState<{ done: number; total: number } | null>(null);
  const preparing = useRef(false);
  const readRanges = useRef(new Map<string, Range>());
  const [readSel, setReadSel] = useState<ReflowSelection | null>(null);
  /** The page to show once the view changes: the page the old view showed at its top. */
  const pendingPage = useRef<number | null>(null);
  /** Set once the reader scrolls, taps or types in the document: from then on the view never changes by itself. */
  const userMoved = useRef(false);
  /** A PDF set in columns opens on its pages; a reader who picks the reading view for it here keeps it. */
  const columnsOk = useRef(localStorage.getItem(columnsKey(doc)) === "1");

  // ---- Load the PDF -------------------------------------------------------------------------

  useEffect(() => {
    let pdf: PDFDoc | undefined;
    let cancelled = false;
    setAttention(folder.id, "reading");
    void (async () => {
      try {
        const data = await loadPdfData(folder.id, doc);
        if (cancelled) return;
        if (!data) return setLoad({ state: "missing" });
        pdf = await openPdf(data);
        const toc = await loadOutline(pdf);
        // Every page's size up front, so the scrollbar is right from the start.
        const sizes: PageSize[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return;
        setLoad({ state: "ready", pdf, sizes, outline: toc });
        void ensureThumb(folder.id, doc, data);
        void indexDocument(folder.id, doc, data);
      } catch (e) {
        if (!cancelled) setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      setAttention(folder.id, "open");
      void pdf?.loadingTask.destroy();
    };
  }, [folder.id, doc]);

  // ---- Layout -------------------------------------------------------------------------------

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      setView({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [load.state]);

  const sizes = load.state === "ready" ? load.sizes : [];
  const pdf = load.state === "ready" ? load.pdf : null;
  const outline = load.state === "ready" ? load.outline : NO_OUTLINE;
  const fit = useMemo(() => {
    const widest = Math.max(1, ...sizes.map((s) => s.w));
    return Math.max(0.2, Math.min(viewW - PAD * 2, MAX_FIT_WIDTH) / widest);
  }, [sizes, viewW]);
  const scale = fit * zoom;
  const tops = useMemo(() => {
    const t: number[] = [];
    let y = PAD;
    for (const s of sizes) {
      t.push(y);
      y += Math.floor(s.h * scale) + GAP;
    }
    t.push(y);
    return t;
  }, [sizes, scale]);

  /**
   * The place under the top third of the screen: a page and how far into it, as a fraction. In the
   * reading view it is the block there instead, with no fraction. Null while there is no text to read.
   */
  const locate = useCallback(
    (scrollTop: number, height: number, el: HTMLElement | null = scroller.current) => {
      const probe = scrollTop + height / 3;
      if (reading) {
        // The element is passed in by the scroll listeners: on unmount the ref is already cleared.
        const block = el && readingBlockAt(el, probe);
        if (!block || !el) return null;
        // How far down the block the probe line is, so a place can be kept within a paragraph.
        const top = block.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        return { page: Number(block.dataset.page), offset: 0, block, within: clamp((probe - top) / Math.max(1, block.offsetHeight), 0, 1) };
      }
      let lo = 0;
      let hi = sizes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= probe) lo = mid;
        else hi = mid - 1;
      }
      const h = Math.floor((sizes[lo]?.h ?? 1) * scale);
      return { page: lo + 1, offset: clamp((scrollTop - tops[lo]) / h, -1, 1) };
    },
    [sizes, tops, scale, reading],
  );

  // The scroll listeners call the latest locate, so a view switch never saves one view's place against the other's layout.
  const locateRef = useRef(locate);
  useLayoutEffect(() => {
    locateRef.current = locate;
  });

  const scrollToPage = useCallback(
    (page: number, offset = 0, smooth = false) => {
      const el = scroller.current;
      if (!el || !sizes.length) return;
      if (reading) {
        const block = readingBlockOnPage(el, page);
        if (block) scrollReadingTo(el, block, smooth);
        return;
      }
      const i = clamp(page, 1, sizes.length) - 1;
      el.scrollTo({ top: tops[i] + offset * Math.floor(sizes[i].h * scale) - (offset ? 0 : PAD / 2), behavior: smooth ? scrollMotion() : "auto" });
    },
    [sizes, tops, scale, reading],
  );

  // Restore the reading position once, after the first layout (and, in the reading view, once its text is in).
  const restored = useRef(false);
  /** Puts the reading view back on the line the reader left: a block, and how far down it, a third of the way down the window. */
  const restorePlace = (place: ReadingPlace) => {
    const el = scroller.current;
    const block = el?.querySelector<HTMLElement>(`.reflow-block[data-index="${place.block}"]`);
    if (!el || !block) return;
    const top = block.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTo({ top: top + place.within * block.offsetHeight - el.clientHeight / 3, behavior: "auto" });
  };
  useEffect(() => {
    if (restored.current || load.state !== "ready" || !viewW || (reading && (!reflow || (reflow.columns && !columnsOk.current)))) return;
    restored.current = true;
    void (async () => {
      if (startPage) return scrollToPage(startPage);
      const pos = await db.positions.get(doc);
      // The place left in the reading view is used when it is no older than the synced position.
      const place = readPlace(doc);
      if (reading && place && place.at >= (pos?.updatedAt ?? 0)) return restorePlace(place);
      if (pos) scrollToPage(pos.page, pos.offset);
    })();
  }, [load.state, viewW, startPage, db, doc, scrollToPage, reading, reflow]);

  // Keep the same spot on screen when the zoom changes. The reading view keeps its block, which stays in place through a size change.
  const anchor = useRef<{ page: number; offset: number; block?: HTMLElement; within?: number } | null>(null);
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (prevScale.current !== scale && a && restored.current) {
      if (a.block?.isConnected && scroller.current) scrollReadingTo(scroller.current, a.block, false);
      else scrollToPage(a.page, a.offset);
    }
    prevScale.current = scale;
  }, [scale, scrollToPage]);

  // Where the reader is. Before the reading text is in, the last place in the page view stands in for it.
  const here = (view.height ? locate(view.top, view.height) : null) ?? anchor.current ?? { page: startPage ?? 1, offset: 0 };

  // ---- Scrolling and position saving -------------------------------------------------------

  useEffect(() => {
    const el = scroller.current;
    if (!el || load.state !== "ready") return;
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!restored.current) return;
      const place = locateRef.current(el.scrollTop, el.clientHeight, el);
      if (!place) return;
      void savePosition(folder.id, doc, place.page, place.offset);
      // In the reading view, the block and how far down it stay on this device, for the next open.
      if (place.block && place.within !== undefined) {
        localStorage.setItem(placeKey(doc), JSON.stringify({ version: REFLOW_VERSION, block: Number(place.block.dataset.index), within: place.within, at: Date.now() }));
      }
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setView({ top: el.scrollTop, height: el.clientHeight });
        anchor.current = locateRef.current(el.scrollTop, el.clientHeight, el);
      });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1200);
    };
    const onHide = () => document.visibilityState === "hidden" && save();
    // Scrolling done by a restore is not the reader's; a wheel, a touch, a press or a key is.
    const onMove = () => void (userMoved.current = true);
    const moves = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const m of moves) el.addEventListener(m, onMove, { passive: true });
    document.addEventListener("visibilitychange", onHide);
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const m of moves) el.removeEventListener(m, onMove);
      document.removeEventListener("visibilitychange", onHide);
      cancelAnimationFrame(frame);
      clearTimeout(saveTimer);
      save();
    };
  }, [load.state, folder.id, doc]);

  const changeZoom = useCallback((dir: 1 | -1 | 0) => {
    setZoom((z) => {
      const next = dir === 0 ? 1 : dir > 0 ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? z) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? z);
      localStorage.setItem("reader.zoom", String(next));
      return next;
    });
  }, []);

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way) zooms the document.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      changeZoom(acc < 0 ? 1 : -1);
      acc = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [load.state, changeZoom]);

  // ---- Highlights and ink -------------------------------------------------------------------

  const pageOf = useCallback((el: Element) => {
    const pageEl = el.closest<HTMLElement>(".page");
    return pageEl ? { page: Number(pageEl.dataset.page), el: pageEl } : null;
  }, []);

  const highlight = useCallback(
    // `askWhy` opens the new highlight for an optional line in the reader's own words. Quick strokes
    // with the highlighter tool skip it so they stay quick.
    async (color: string, parts: Map<number, PagePart>, askWhy = false) => {
      setLastColor(color);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      // One highlight per page the selection touches, each with that page's own words.
      let first: Annotation | undefined;
      for (const [page, part] of parts) {
        const a = await saveAnnotation(folder.id, { doc, kind: "highlight", page, color, rects: part.rects, quote: part.quote, prefix: part.prefix, suffix: part.suffix });
        first ??= a;
      }
      if (askWhy && first) {
        const hit = document.querySelector(`.page[data-page="${first.page}"] .hl-hit`);
        const box = scroller.current!.querySelector(`.page[data-page="${first.page}"]`)!.getBoundingClientRect();
        const r = first.rects![0];
        const anchorRect = hit?.getBoundingClientRect() ?? new DOMRect(box.left + r.x * box.width, box.top + r.y * box.height, r.w * box.width, r.h * box.height);
        setPicked({ id: first.id, anchor: anchorRect, edit: true });
      }
    },
    [folder.id, doc],
  );

  // Fingers and pens: tools mark the page, two fingers scroll. In the reading view the text is what they mark.
  useTouchTools(scroller, tool, load.state === "ready", reading ? REFLOW_SURFACE : undefined);

  // After a text selection ends: highlight straight away with the highlighter, else offer a popover.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onUp = () =>
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        // A drag that starts or ends inside a word takes the whole word.
        const range = snapRange(sel.getRangeAt(0));
        if (!el.contains(range.commonAncestorContainer)) return;
        const parts = selectionParts(range, pageOf);
        const text = [...parts.values()].map((p) => p.quote).join(" ");
        if (!text) return;
        if (tool === "highlight") void highlight(lastColor(), parts);
        else {
          const all = Array.from(range.getClientRects());
          const last = all[all.length - 1] ?? range.getBoundingClientRect();
          setSelection({ anchor: last, text, parts });
        }
      }, 0);
    el.addEventListener("pointerup", onUp);
    return () => el.removeEventListener("pointerup", onUp);
  }, [load.state, tool, pageOf, highlight]);

  const deleteWithUndo = useCallback(
    async (id: string, what: string) => {
      setPicked(null);
      await deleteAnnotation(folder.id, id);
      toast(`${what} deleted`, { action: { label: "Undo", run: () => void updateAnnotation(folder.id, id, { deleted: false }) } });
    },
    [folder.id],
  );

  const onInk = useCallback(
    (page: number, points: number[]) => void saveAnnotation(folder.id, { doc, kind: "ink", page, color: inkColor, points, size: inkSize }),
    [folder.id, doc, inkColor],
  );
  const onErase = useCallback((id: string) => void deleteAnnotation(folder.id, id), [folder.id]);
  const onPick = useCallback((a: Annotation, anchorRect: DOMRect) => setPicked({ id: a.id, anchor: anchorRect }), []);
  const pickedAnnotation = picked ? annotations.find((a) => a.id === picked.id) : undefined;
  const changePicked = useCallback((patch: Partial<Annotation>) => picked && void updateAnnotation(folder.id, picked.id, patch), [folder.id, picked]);

  const byPage = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of annotations) m.set(a.page, [...(m.get(a.page) ?? []), a]);
    return m;
  }, [annotations]);

  // ---- Reading view -------------------------------------------------------------------------

  // The text is extracted once, for a reader who prefers the reading view, while the pages stay on screen. A
  // cached copy is used when there is one. After that it stays in state.
  useEffect(() => {
    if (!(reading || prefersReading.current) || !pdf || reflow || preparing.current) return;
    preparing.current = true;
    setPrep({ done: 0, total: pdf.numPages });
    reflowFor(folder.id, doc, pdf, (done, total) => setPrep({ done, total }))
      .then(setReflow)
      .catch((e: unknown) => {
        autoPage.current = false;
        setReading(false);
        toast(`Couldn't prepare the reading view. ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        preparing.current = false;
        setPrep(null);
      });
  }, [reading, pdf, reflow, folder.id, doc]);

  /**
   * Switches between the page view and the reading view. The new view opens at the page the old one
   * showed at its top. `remember` keeps the choice for next time; automatic switches don't.
   */
  const switchView = (next: boolean, remember = true) => {
    if (next === reading) return;
    pendingPage.current = here.page;
    setSelection(null);
    setReadSel(null);
    setPicked(null);
    // Pen and eraser need the pages, so they stay out of the reading view.
    if (next && (tool === "ink" || tool === "eraser")) setTool("select");
    // A switch the reader makes is remembered. One the app makes (find, the pen) is not, and comes back by itself.
    autoPage.current = !next && !remember;
    opening.current = false;
    if (remember) {
      localStorage.setItem("reader.view", next ? "reading" : "page");
      prefersReading.current = next;
      // Choosing the reading view holds even for a PDF in columns, and for one known to be in columns, next time too.
      if (next) {
        columnsOk.current = true;
        if (reflow?.columns) localStorage.setItem(columnsKey(doc), "1");
      }
    }
    setReading(next);
  };
  // For a toast's button, which is pressed after later renders.
  const switchRef = useRef(switchView);
  useLayoutEffect(() => {
    switchRef.current = switchView;
  });

  // A PDF set in columns opens on its pages, where its columns read as printed, unless the reader chose the reading view for it.
  useEffect(() => {
    if (!reading || !reflow?.columns || columnsOk.current) return;
    autoPage.current = false;
    setReading(false);
  }, [reading, reflow]);

  // Once the text is ready, a reader who prefers the reading view moves to it, at the same place. Find and the pen
  // hold the pages while they're open. A PDF with no text, or set in columns, stays on the pages. A reader who has
  // started reading the pages is not moved under them: they are told the reading view is ready instead.
  useEffect(() => {
    if (!autoPage.current || reading || !reflow || findOpen || tool === "ink" || tool === "eraser") return;
    autoPage.current = false;
    if (!reflow.blocks.length || (reflow.columns && !columnsOk.current)) return;
    if (!opening.current || !userMoved.current) return switchView(true, false);
    opening.current = false;
    toast("The reading view is ready.", { action: { label: "Switch", run: () => switchRef.current(true, false) } });
  }, [reflow, reading, findOpen, tool]);

  // Once the view can show a page (the reading view, once its text is in), go to the page the old view showed.
  useLayoutEffect(() => {
    if (pendingPage.current === null || load.state !== "ready" || (reading && !reflow)) return;
    scrollToPage(pendingPage.current);
    pendingPage.current = null;
  }, [reading, reflow, load.state, scrollToPage]);

  /** Pen and eraser need the pages, so choosing either one brings back the page view. */
  const chooseTool = (t: Tool) => {
    if (reading && (t === "ink" || t === "eraser")) switchView(false, false);
    setTool(t);
  };

  const highlightReading = useCallback(
    async (color: string, sel: ReflowSelection, askWhy = false) => {
      if (!pdf) return;
      setLastColor(color);
      window.getSelection()?.removeAllRanges();
      setReadSel(null);
      // A passage can run over a page break, and is then saved once per page it touches, each part with that page's
      // words, as a page-view selection is.
      const parts = await rectsForQuoteAcross(pdf, sel.page, sel.text, { prefix: sel.prefix, suffix: sel.suffix });
      if (!parts) return void toast("Couldn't place that on the page. Try the page view.");
      let first: Annotation | undefined;
      for (const part of parts) {
        const a = await saveAnnotation(folder.id, { doc, kind: "highlight", page: part.page, color, rects: part.rects, quote: part.quote, prefix: part.prefix, suffix: part.suffix });
        first ??= a;
      }
      if (askWhy && first) setPicked({ id: first.id, anchor: sel.anchor, edit: true });
    },
    [pdf, folder.id, doc],
  );

  const onReadSelect = useCallback(
    (sel: ReflowSelection) => {
      // As in the page view: the highlighter marks at once, and the other tools offer the colours.
      if (tool === "highlight") void highlightReading(lastColor(), sel);
      else setReadSel(sel);
    },
    [tool, highlightReading],
  );
  const onReadPick = useCallback((id: string, anchor: DOMRect) => setPicked({ id, anchor }), []);

  // ---- Find in document ---------------------------------------------------------------------

  const findTerms = useMemo(() => (findOpen ? findText.trim().split(/\s+/).filter(Boolean) : []), [findOpen, findText]);
  const [findPages, setFindPages] = useState<number[]>([]);
  useEffect(() => {
    if (!findTerms.length || load.state !== "ready") return setFindPages([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      const pdf = load.pdf;
      const lower = findTerms.map((x) => x.toLowerCase());
      const hits: number[] = [];
      for (let i = 1; i <= pdf.numPages && !cancelled; i++) {
        let text = (await db.pageText.get([doc, i]))?.text;
        if (text === undefined) {
          const content = await (await pdf.getPage(i)).getTextContent();
          text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
        }
        const low = text.toLowerCase();
        if (lower.every((x) => low.includes(x))) hits.push(i);
      }
      if (!cancelled) setFindPages(hits);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [findTerms, load, db, doc]);

  // Jump to the first match once results arrive for a search that came from the library search.
  const jumpedForFind = useRef(false);
  useEffect(() => {
    if (jumpedForFind.current || !startFind || !findPages.length || !restored.current) return;
    jumpedForFind.current = true;
    if (!startPage) scrollToPage(findPages[0]);
  }, [findPages, startFind, startPage, scrollToPage]);

  const findStep = (dir: 1 | -1) => {
    if (!findPages.length) return;
    const next = dir > 0 ? (findPages.find((p) => p > here.page) ?? findPages[0]) : ([...findPages].reverse().find((p) => p < here.page) ?? findPages[findPages.length - 1]);
    scrollToPage(next, 0, true);
  };
  const findIndex = findPages.indexOf(here.page);

  // Matches are marked on the pages, so opening the find bar brings back the page view.
  const openFind = () => {
    if (reading) switchView(false, false);
    setFindOpen(true);
  };

  // ---- Keyboard -----------------------------------------------------------------------------

  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && e.key === "f") || (!typing && !mod && e.key === "/")) {
        e.preventDefault();
        openFind();
        setTimeout(() => findInput.current?.select(), 0);
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        changeZoom(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        changeZoom(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        changeZoom(0);
      } else if (typing || mod || e.altKey) {
        return;
      } else if (e.key === "Escape") {
        if (selection || readSel || picked) return;
        if (findOpen) setFindOpen(false);
        else if (tool !== "select") setTool("select");
        else navigate({ name: "library", folder: folder.id });
      } else if (e.key === "v") setTool("select");
      else if (e.key === "h") setTool((t) => (t === "highlight" ? "select" : "highlight"));
      else if (e.key === "d") chooseTool(tool === "ink" ? "select" : "ink");
      else if (e.key === "e") chooseTool(tool === "eraser" ? "select" : "eraser");
      else if (e.key === "n") openNotes();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const togglePanel = () =>
    setPanel((p) => {
      localStorage.setItem("reader.panel", p ? "0" : "1");
      return !p;
    });

  // Notes always opens on All, so a Contents visit doesn't leave it showing the outline.
  const openNotes = () => {
    if (!panel) setPanelTab("all");
    togglePanel();
  };

  // The Contents button opens the panel on its tab, or closes the panel when it is already showing that.
  const openContents = () => {
    if (panel && panelTab === "contents") togglePanel();
    else {
      setPanelTab("contents");
      if (!panel) togglePanel();
    }
  };

  // ---- Render -------------------------------------------------------------------------------

  const title = meta?.title ?? "Document";
  useEffect(() => {
    document.title = `${title} · Engram`;
    return () => void (document.title = "Engram");
  }, [title]);

  const near = (i: number) => tops[i + 1] > view.top - view.height && tops[i] < view.top + view.height * 2;

  return (
    <div className="reader">
      <header className="reader-bar">
        <button className="icon-btn" aria-label="Back to library" title="Back to library (Esc)" onClick={() => navigate({ name: "library", folder: folder.id })}>
          <ArrowLeft size={20} />
        </button>
        <div className="reader-title" title={title}>
          <strong>{title}</strong>
          {load.state === "ready" && (
            <span className="muted">
              {here.page} / {sizes.length}
            </span>
          )}
        </div>
        <div className="spacer" />

        <div className="seg reader-view" role="group" aria-label="View">
          <button className={reading ? "" : "on"} aria-pressed={!reading} title="Page view" onClick={() => switchView(false)}>
            Page
          </button>
          <button className={reading ? "on" : ""} aria-pressed={reading} title="Reading view" onClick={() => switchView(true)}>
            Reading
          </button>
        </div>
        {!reading && prep && (
          <span className="reader-prep muted" role="status">
            Preparing the reading view, {prep.done} of {prep.total} pages
          </span>
        )}

        <div className="toolgroup" role="toolbar" aria-label="Tools">
          <ToolButton tool="select" cur={tool} set={setTool} label="Select (V)" icon={<MousePointer2 size={18} />} />
          <ToolButton tool="highlight" cur={tool} set={setTool} label="Highlighter (H)" icon={<Highlighter size={18} />} />
          <ToolButton tool="ink" cur={tool} set={chooseTool} label="Pen (D)" icon={<PenLine size={18} />} />
          <ToolButton tool="eraser" cur={tool} set={chooseTool} label="Eraser (E)" icon={<Eraser size={18} />} />
        </div>
        {tool === "ink" && (
          <div className="toolgroup ink-colors" aria-label="Pen colour">
            {INK_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch small ink-swatch ${inkColor === c ? "on" : ""}`}
                style={{ "--c": c } as React.CSSProperties}
                aria-label={`Pen colour ${c}`}
                aria-pressed={inkColor === c}
                onClick={() => {
                  setInkColor(c);
                  localStorage.setItem("reader.ink", c);
                }}
              />
            ))}
          </div>
        )}

        <div className="toolgroup reader-zoom">
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out (Ctrl −)" onClick={() => changeZoom(-1)}>
            <ZoomOut size={18} />
          </button>
          <button className="zoom-label" title="Fit width (Ctrl 0)" onClick={() => changeZoom(0)}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in (Ctrl +)" onClick={() => changeZoom(1)}>
            <ZoomIn size={18} />
          </button>
        </div>

        <button className={`icon-btn ${findOpen ? "on" : ""}`} aria-label="Find in document" title="Find (Ctrl F)" onClick={() => (findOpen ? setFindOpen(false) : openFind())}>
          <SearchIcon size={18} />
        </button>
        {outline.length > 0 && (
          <button className={`icon-btn ${panel && panelTab === "contents" ? "on" : ""}`} aria-label="Contents" title="Contents" onClick={openContents}>
            <ListTree size={18} />
          </button>
        )}
        <button className={`icon-btn ${panel ? "on" : ""}`} aria-label="Notes" title="Notes (N)" onClick={openNotes}>
          <NotebookPen size={18} />
          {annotations.length > 0 && <span className="count">{annotations.length}</span>}
        </button>
        <SyncBadge s={syncState} onClick={() => (account ? void folderCtx(folder.id).sync.flush() : navigate({ name: "setup" }))} />
      </header>

      {findOpen && (
        <div className="find-bar">
          <SearchIcon size={16} className="muted" />
          <input
            ref={findInput}
            autoFocus
            value={findText}
            placeholder="Find in this document"
            aria-label="Find in this document"
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") findStep(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") setFindOpen(false);
            }}
          />
          <span className="muted find-count">
            {findTerms.length ? (findPages.length ? `${findIndex >= 0 ? `${findIndex + 1} of ` : ""}${findPages.length} page${findPages.length === 1 ? "" : "s"}` : "No matches") : ""}
          </span>
          <button className="icon-btn" aria-label="Previous match" disabled={!findPages.length} onClick={() => findStep(-1)}>
            <ChevronUp size={18} />
          </button>
          <button className="icon-btn" aria-label="Next match" disabled={!findPages.length} onClick={() => findStep(1)}>
            <ChevronDown size={18} />
          </button>
          <button className="icon-btn" aria-label="Close find" onClick={() => setFindOpen(false)}>
            <X size={18} />
          </button>
        </div>
      )}

      <div className="reader-body">
        <div ref={scroller} className={`pages tool-${tool}`} tabIndex={-1}>
          {load.state === "loading" && <div className="reader-msg">Opening…</div>}
          {load.state === "missing" && (
            <div className="reader-msg">
              <h2>This PDF isn't on this device yet</h2>
              <p>{account ? "It couldn't be downloaded from GitHub. Check your connection and try again." : "Connect GitHub to download it from this folder's repository."}</p>
              <button className="btn btn-primary" onClick={() => (account ? location.reload() : navigate({ name: "setup" }))}>
                {account ? "Try again" : "Connect GitHub"}
              </button>
            </div>
          )}
          {load.state === "error" && (
            <div className="reader-msg">
              <h2>Couldn't open this PDF</h2>
              <p className="muted">{load.message}</p>
            </div>
          )}
          {load.state === "ready" && reading &&
            (reflow ? (
              <ReflowView
                reflow={reflow}
                size={READING_SIZE * zoom}
                annotations={annotations}
                selectedId={picked?.id}
                ranges={readRanges}
                onSelect={onReadSelect}
                onPick={onReadPick}
              />
            ) : (
              <div className="reflow-status" role="status">
                Preparing the text… {prep?.done ?? 0} of {prep?.total ?? load.pdf.numPages} pages
              </div>
            ))}
          {load.state === "ready" && !reading && (
            <div className="page-stack" style={{ height: tops[tops.length - 1] + PAD }}>
              {sizes.map((s, i) =>
                near(i) ? (
                  <div key={i} className="page-slot" style={{ top: tops[i] }}>
                    <PageView
                      pdf={load.pdf}
                      page={i + 1}
                      size={s}
                      scale={scale}
                      near
                      annotations={byPage.get(i + 1) ?? EMPTY}
                      tool={tool}
                      inkColor={inkColor}
                      inkSize={inkSize}
                      findTerms={findPages.includes(i + 1) ? findTerms : EMPTY_TERMS}
                      selectedId={picked?.id}
                      onPickAnnotation={onPick}
                      onInk={onInk}
                      onErase={onErase}
                    />
                  </div>
                ) : null,
              )}
              {peers.map((p) => (
                <button
                  key={p.key}
                  className="peer-marker"
                  style={{ top: (tops[p.page - 1] ?? 0) + p.offset * Math.floor((sizes[p.page - 1]?.h ?? 0) * scale) }}
                  title={`${p.user} is here (page ${p.page})`}
                  onClick={() => scrollToPage(p.page, p.offset, true)}
                >
                  {p.user}
                </button>
              ))}
            </div>
          )}
        </div>
        {panel && (
          <NotesPanel
            item={meta}
            annotations={annotations}
            outline={outline}
            tab={panelTab}
            onTab={setPanelTab}
            me={account?.login}
            onJump={(a) => {
              // In the reading view a highlight is jumped to where its text is; the page view goes by the page.
              const range = reading ? readRanges.current.get(a.id) : undefined;
              if (range && scroller.current) scrollReadingTo(scroller.current, range, true);
              else scrollToPage(a.page, Math.max(0, (a.rects?.[0]?.y ?? 0) - 0.15), true);
              if (window.innerWidth < 900) setPanel(false);
            }}
            onPage={(page) => {
              scrollToPage(page, 0, true);
              if (window.innerWidth < 900) setPanel(false);
            }}
            onDelete={(a) => void deleteWithUndo(a.id, a.kind === "ink" ? "Drawing" : "Highlight")}
            onClose={togglePanel}
          />
        )}
      </div>

      {selection && (
        <SelectionPopover
          anchor={selection.anchor}
          text={selection.text}
          item={meta}
          page={[...selection.parts.keys()][0]}
          onHighlight={(color) => void highlight(color, selection.parts, true)}
          onClose={() => setSelection(null)}
        />
      )}
      {readSel && (
        <SelectionPopover
          anchor={readSel.anchor}
          text={readSel.text}
          item={meta}
          page={readSel.page}
          onHighlight={(color, withNote) => void highlightReading(color, readSel, withNote)}
          onClose={() => setReadSel(null)}
        />
      )}
      {picked && pickedAnnotation && (
        <AnnotationPopover
          key={picked.id}
          anchor={picked.anchor}
          annotation={pickedAnnotation}
          item={meta}
          startEditing={picked.edit}
          onChange={changePicked}
          onDelete={() => void deleteWithUndo(picked.id, "Highlight")}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}

const EMPTY: Annotation[] = [];
const EMPTY_TERMS: string[] = [];
const NO_OUTLINE: OutlineEntry[] = [];

/** Where the reading view was left: a block of the reflow, and how far down it, on this device. */
interface ReadingPlace {
  version: number;
  block: number;
  within: number;
  at: number;
}

const placeKey = (doc: string) => `reader.place:${doc}`;
/** Set when the reader chose the reading view for a PDF set in columns, on this device. */
const columnsKey = (doc: string) => `reader.columns:${doc}`;

/** The reading place for a document, if one was kept for the current extraction. */
function readPlace(doc: string): ReadingPlace | null {
  try {
    const place = JSON.parse(localStorage.getItem(placeKey(doc)) ?? "null") as ReadingPlace | null;
    return place?.version === REFLOW_VERSION ? place : null;
  } catch {
    return null;
  }
}

function ToolButton({ tool, cur, set, label, icon }: { tool: Tool; cur: Tool; set: (t: Tool) => void; label: string; icon: React.ReactNode }) {
  return (
    <button className={`icon-btn ${cur === tool ? "on" : ""}`} aria-label={label} title={label} aria-pressed={cur === tool} onClick={() => set(tool)}>
      {icon}
    </button>
  );
}
