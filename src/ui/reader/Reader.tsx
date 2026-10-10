import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Eraser,
  Highlighter,
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
import { clamp } from "../../lib/util";
import { INK_COLORS, type Annotation, type Folder } from "../../model";
import { selectionRects } from "../../reader/geometry";
import { deleteAnnotation, ensureThumb, indexDocument, loadPdfData, saveAnnotation, savePosition, updateAnnotation } from "../../store/actions";
import { noteFromHighlight } from "../../notes/notes";
import { navigate, toast } from "../../store/ui";
import { useAccount } from "../../sync/account";
import { SyncBadge, useFolderSync } from "../common";
import { NotesPanel } from "./NotesPanel";
import { PageView, type PageSize, type Tool } from "./PageView";
import { AnnotationPopover, lastColor, SelectionPopover, setLastColor } from "./Popovers";

const GAP = 16;
const PAD = 16;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Fit-to-width stops growing past this, so lines stay readable on wide screens. */
const MAX_FIT_WIDTH = 980;

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; pdf: PDFDoc; sizes: PageSize[] };

export function Reader({ folder, doc, page: startPage, find: startFind }: { folder: Folder; doc: string; page?: number; find?: string }) {
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
  const [panel, setPanel] = useState(() => localStorage.getItem("reader.panel") === "1" && window.innerWidth > 900);
  const [findOpen, setFindOpen] = useState(!!startFind);
  const [findText, setFindText] = useState(startFind ?? "");
  const [selection, setSelection] = useState<{ anchor: DOMRect; text: string; rects: Map<number, Annotation["rects"]> } | null>(null);
  const [picked, setPicked] = useState<{ id: string; anchor: DOMRect; edit?: boolean } | null>(null);

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
        // Every page's size up front, so the scrollbar is right from the start.
        const sizes: PageSize[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return;
        setLoad({ state: "ready", pdf, sizes });
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

  /** Page under the top third of the screen, plus how far into it, as a fraction. */
  const locate = useCallback(
    (scrollTop: number, height: number) => {
      const probe = scrollTop + height / 3;
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
    [sizes, tops, scale],
  );

  const scrollToPage = useCallback(
    (page: number, offset = 0, smooth = false) => {
      const el = scroller.current;
      const i = clamp(page, 1, sizes.length) - 1;
      if (!el || !sizes.length) return;
      el.scrollTo({ top: tops[i] + offset * Math.floor(sizes[i].h * scale) - (offset ? 0 : PAD / 2), behavior: smooth ? "smooth" : "auto" });
    },
    [sizes, tops, scale],
  );

  // Restore the reading position once, after the first layout.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || load.state !== "ready" || !viewW) return;
    restored.current = true;
    void (async () => {
      if (startPage) return scrollToPage(startPage);
      const pos = await db.positions.get(doc);
      if (pos) scrollToPage(pos.page, pos.offset);
    })();
  }, [load.state, viewW, startPage, db, doc, scrollToPage]);

  // Keep the same spot on screen when the zoom changes.
  const anchor = useRef<{ page: number; offset: number } | null>(null);
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    if (prevScale.current !== scale && anchor.current && restored.current) scrollToPage(anchor.current.page, anchor.current.offset);
    prevScale.current = scale;
  }, [scale, scrollToPage]);

  const here = view.height ? locate(view.top, view.height) : { page: startPage ?? 1, offset: 0 };

  // ---- Scrolling and position saving -------------------------------------------------------

  useEffect(() => {
    const el = scroller.current;
    if (!el || load.state !== "ready") return;
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!restored.current) return;
      const { page, offset } = locate(el.scrollTop, el.clientHeight);
      void savePosition(folder.id, doc, page, offset);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setView({ top: el.scrollTop, height: el.clientHeight });
        anchor.current = locate(el.scrollTop, el.clientHeight);
      });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1200);
    };
    const onHide = () => document.visibilityState === "hidden" && save();
    el.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onHide);
    return () => {
      el.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      cancelAnimationFrame(frame);
      clearTimeout(saveTimer);
      save();
    };
  }, [load.state, locate, folder.id, doc]);

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
    async (color: string, rects: Map<number, Annotation["rects"]>, quote: string, askWhy = false) => {
      setLastColor(color);
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      let first: Annotation | undefined;
      for (const [page, r] of rects) {
        const a = await saveAnnotation(folder.id, { doc, kind: "highlight", page, color, rects: r, quote });
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

  // After a text selection ends: highlight straight away with the highlighter, else offer a popover.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onUp = () =>
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) return;
        const text = sel.toString().replace(/\s+/g, " ").trim();
        const rects = selectionRects(range, pageOf);
        if (!text || !rects.size) return;
        if (tool === "highlight") void highlight(lastColor(), rects, text);
        else {
          const all = Array.from(range.getClientRects());
          const last = all[all.length - 1] ?? range.getBoundingClientRect();
          setSelection({ anchor: last, text, rects });
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

  // ---- Keyboard -----------------------------------------------------------------------------

  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && e.key === "f") || (!typing && !mod && e.key === "/")) {
        e.preventDefault();
        setFindOpen(true);
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
        if (selection || picked) return;
        if (findOpen) setFindOpen(false);
        else if (tool !== "select") setTool("select");
        else navigate({ name: "library", folder: folder.id });
      } else if (e.key === "v") setTool("select");
      else if (e.key === "h") setTool((t) => (t === "highlight" ? "select" : "highlight"));
      else if (e.key === "d") setTool((t) => (t === "ink" ? "select" : "ink"));
      else if (e.key === "e") setTool((t) => (t === "eraser" ? "select" : "eraser"));
      else if (e.key === "n") togglePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const togglePanel = () =>
    setPanel((p) => {
      localStorage.setItem("reader.panel", p ? "0" : "1");
      return !p;
    });

  // ---- Render -------------------------------------------------------------------------------

  const title = meta?.title ?? "Document";
  useEffect(() => {
    document.title = `${title} · Engram`;
    return () => void (document.title = "Engram");
  }, [title]);

  const near = (i: number) => tops[i + 1] > view.top - view.height && tops[i] < view.top + view.height * 2;

  return (
    <div className={`reader ${panel ? "with-panel" : ""}`}>
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

        <div className="toolgroup" role="toolbar" aria-label="Tools">
          <ToolButton tool="select" cur={tool} set={setTool} label="Select (V)" icon={<MousePointer2 size={18} />} />
          <ToolButton tool="highlight" cur={tool} set={setTool} label="Highlighter (H)" icon={<Highlighter size={18} />} />
          <ToolButton tool="ink" cur={tool} set={setTool} label="Pen (D)" icon={<PenLine size={18} />} />
          <ToolButton tool="eraser" cur={tool} set={setTool} label="Eraser (E)" icon={<Eraser size={18} />} />
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

        <div className="toolgroup hide-narrow">
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

        <button className={`icon-btn ${findOpen ? "on" : ""}`} aria-label="Find in document" title="Find (Ctrl F)" onClick={() => setFindOpen((o) => !o)}>
          <SearchIcon size={18} />
        </button>
        <button className={`icon-btn ${panel ? "on" : ""}`} aria-label="Notes" title="Notes (N)" onClick={togglePanel}>
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
          {load.state === "ready" && (
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
            title={title}
            annotations={annotations}
            me={account?.login}
            onJump={(a) => {
              scrollToPage(a.page, Math.max(0, (a.rects?.[0]?.y ?? 0) - 0.15), true);
              if (window.innerWidth < 900) setPanel(false);
            }}
            onClose={togglePanel}
          />
        )}
      </div>

      {selection && (
        <SelectionPopover
          anchor={selection.anchor}
          text={selection.text}
          onHighlight={(color) => void highlight(color, selection.rects, selection.text, true)}
          onClose={() => setSelection(null)}
        />
      )}
      {picked && pickedAnnotation && (
        <AnnotationPopover
          key={picked.id}
          anchor={picked.anchor}
          annotation={pickedAnnotation}
          startEditing={picked.edit}
          onChange={changePicked}
          onDelete={() => void deleteWithUndo(picked.id, "Highlight")}
          onMakeNote={
            meta
              ? async () => {
                  const note = await noteFromHighlight(folder.id, meta, pickedAnnotation.quote!, pickedAnnotation.page);
                  navigate({ name: "item", folder: folder.id, item: note.id });
                }
              : undefined
          }
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}

const EMPTY: Annotation[] = [];
const EMPTY_TERMS: string[] = [];

function ToolButton({ tool, cur, set, label, icon }: { tool: Tool; cur: Tool; set: (t: Tool) => void; label: string; icon: React.ReactNode }) {
  return (
    <button className={`icon-btn ${cur === tool ? "on" : ""}`} aria-label={label} title={label} aria-pressed={cur === tool} onClick={() => set(tool)}>
      {icon}
    </button>
  );
}
