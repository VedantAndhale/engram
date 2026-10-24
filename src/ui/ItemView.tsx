import { useLiveQuery } from "dexie-react-hooks";
import {
  AArrowDown,
  AArrowUp,
  Archive,
  ArrowLeft,
  Clock,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FolderInput,
  Highlighter,
  Inbox,
  Link2,
  MessageSquareText,
  NotebookPen,
  Pencil,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { hostOf, itemHref, safeHref, TYPE_LABELS } from "../capture/capture";
import { scrollMotion } from "../lib/util";
import { fillFromWeb } from "../capture/fetchpage";
import { folderCtx } from "../folders/registry";
import { downloadMarkdown, itemToMarkdown, markdownFilename } from "../notes/export";
import { parseTarget } from "../notes/links";
import { backlinks, findHighlight, highlightsOf, noteFromHighlight, openOrCreate, renameWithLinks, resolveEmbed } from "../notes/notes";
import { setHabit, useHabit } from "../habit/prefs";
import { useArticlePosition } from "../reader/articlePosition";
import { articleHeadings } from "../reader/markdown";
import { itemLocation, type Annotation, type Folder, type Location } from "../model";
import { deleteAnnotation, indexDocument, removeItem, restoreItem, setFavorite, setItemBody, setItemTopics, setLocation, updateAnnotation } from "../store/actions";
import { pageBlocks, savedText } from "../ai/source";
import { MoveDialog } from "./Library";
import { openAi } from "../ai/dialog";
import { clearParagraphJump, navigate, toast, useUI } from "../store/ui";
import { plainAnswer } from "../ai/format";
import { useAccount } from "../sync/account";
import type { TitleChoice } from "../editor/completions";
import { PromptDialog, useMenu } from "./common";
import { TopicsDialog } from "./habit";
import { ArticleToc, useRailFits } from "./ArticleToc";
import { ArticleView, scrollArticleTo, stickyReach, type ReadingPrefs } from "./reader/ArticleView";
import { AskBar, summarizeHere } from "./reader/AskBar";
import { LocalGraph } from "./Graph";
import { Listen } from "./reader/Listen";
import { Margin, useMarginFits } from "./reader/Margin";
import { setItemContext, useNotes } from "../ai/notes";
import { turnContext } from "../ai/turn";
import { NotesPanel, type PanelTab } from "./reader/NotesPanel";
import { PlaylistView } from "./PlaylistView";
import { VideoView } from "./VideoView";

// CodeMirror is only needed once an item is open.
const Editor = lazy(() => import("../editor/Editor"));

/** A link, post, quote or note: what it is, your words about it, its highlights and its saved text. */
export function ItemView({ folder, id }: { folder: Folder; id: string }) {
  const { db } = folderCtx(folder.id);
  const item = useLiveQuery(() => db.items.get(id), [id]);
  const quotes = useLiveQuery(
    async () => (await db.annotations.where("doc").equals(id).toArray()).filter((a) => !a.deleted && a.quote?.trim()),
    [id],
  );
  const topics = useHabit((h) => h.topics);
  const [dialog, setDialog] = useState<"rename" | "topics" | "move" | null>(null);
  const menu = useMenu();
  const scroller = useRef<HTMLElement>(null);
  const [highlighter, setHighlighter] = useState(false);
  const [prefs, setPrefs] = useReadingPrefs();
  const [fetching, setFetching] = useState(false);
  // The notes panel beside the text, as in the PDF reader. Both remember whether it is open under one key.
  const { account } = useAccount();
  const [panel, setPanel] = useState(() => localStorage.getItem("reader.panel") === "1" && window.innerWidth > 900);
  const [panelTab, setPanelTab] = useState<PanelTab>("all");
  // The highlights' ids in the order they sit in the text, and where each is painted.
  const [placed, setPlaced] = useState<string[]>([]);
  const ranges = useRef(new Map<string, Range>());

  const linkedFrom = useLiveQuery(async () => (item ? backlinks(db, item.title, item.id) : []), [item?.title, item?.id]);
  // With ids, two items of the same title each get their own choice after "[[".
  const titles = useLiveQuery(async () => {
    const out: TitleChoice[] = [];
    await db.items.each((i) => {
      if (!i.deleted && i.id !== id) out.push({ title: i.title, id: i.id, detail: `${TYPE_LABELS[i.type]} · ${dayOf(i.addedAt)}` });
    });
    return out;
  }, [id]);
  const titlesRef = useRef<TitleChoice[]>([]);
  titlesRef.current = titles ?? [];

  // A link to one highlight in a PDF opens the PDF at that highlight's page.
  const openWiki = async (link: string) => {
    const target = await openOrCreate(folder.id, link);
    if (!target) return;
    if (target.type !== "pdf") return navigate({ name: "item", folder: folder.id, item: target.id });
    const { ref } = parseTarget(link);
    const page = ref ? (await findHighlight(db, target.id, ref))?.page : undefined;
    navigate({ name: "reader", folder: folder.id, doc: target.id, page });
  };

  // Your words are saved as you type, after a short pause; the editor keeps a synced change
  // from another device out while you're typing in it.
  const timer = useRef<number>(undefined);
  const latest = useRef<string | null>(null);
  const onWords = (v: string) => {
    latest.current = v;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void setItemBody(folder.id, id, v);
      latest.current = null;
    }, 600);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (latest.current !== null) void setItemBody(folder.id, id, latest.current);
    },
    [folder.id, id],
  );

  // A bare link, or an article saved as plain text, gets its formatted article from the web once.
  const fillable = !!item && !item.deleted && item.type !== "note" && !!item.sourceUrl && item.contentFormat !== "markdown";
  useEffect(() => {
    if (!fillable) return;
    let live = true;
    setFetching(true);
    void fillFromWeb(folder.id, id).finally(() => live && setFetching(false));
    return () => void (live = false);
  }, [fillable, folder.id, id]);

  // A citation to an article paragraph: scroll to it and flash it.
  const paragraphJump = useUI((s) => s.paragraphJump);
  useEffect(() => {
    if (!paragraphJump || !item || paragraphJump.item !== item.id || !scroller.current) return;
    clearParagraphJump();
    const target = findParagraph(scroller.current, paragraphJump.n, paragraphJump.quote);
    if (!target) {
      toast("That paragraph is no longer in this article.");
      return;
    }
    // Measured from the paragraph itself, below the sticky bars (the top bar and the article's tools
    // under it), as the highlight jumps do. Each bar's place is where it sticks, not where it sits.
    const root = scroller.current;
    const bar = stickyReach(root);
    const top = root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - bar - 24;
    root.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target.classList.add("para-flash");
    window.setTimeout(() => target.classList.remove("para-flash"), 1800);
  }, [paragraphJump, item]);

  // The article's passages, cut once, for every AI note over it.
  useEffect(() => {
    if (!item || item.type === "pdf" || item.type === "note" || !item.content?.trim()) return;
    setItemContext(item.id, turnContext({ key: item.id, title: item.title, text: savedText(item), article: { markdown: item.contentFormat === "markdown" } }));
  }, [item?.id, item?.title, item?.content, item?.contentFormat]);

  useEffect(() => {
    if (item) document.title = `${item.title} · Engram`;
    return () => void (document.title = "Engram");
  }, [item?.title]);

  // Triage from the item itself: E archive, L later, I inbox, S favourite (as in the library).
  const triage = useRef<(e: KeyboardEvent) => void>(() => {});
  triage.current = (e) => {
    if (!item || item.deleted || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]") || document.querySelector(".modal, .menu")) return;
    const key = e.key.toLowerCase();
    if (key === "s") void star(!item.favorite);
    else if (key === "e" || key === "l" || key === "i") void place(key === "e" ? "archive" : key === "l" ? "later" : "inbox");
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => triage.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const place = async (to: Location) => {
    if (!item) return;
    // Undo puts back the stored place, so an item saved under Unread is not filed as Archive once it is read.
    const from = item.location ?? itemLocation(item);
    if (!from || from === to) return;
    await setLocation(folder.id, [item.id], to);
    toast(to === "archive" ? "Archived." : to === "later" ? "Moved to Later." : "Moved to the Inbox.", {
      action: { label: "Undo", run: () => void setLocation(folder.id, [item.id], from) },
    });
  };
  const star = async (on: boolean) => {
    if (!item) return;
    await setFavorite(folder.id, item.id, on);
    toast(on ? "Added to Favourites." : "Removed from Favourites.");
  };

  // A saved text has a reading place and a contents list. Notes and bare links have neither.
  const articleShown = !!item && !item.deleted && !!item.content && item.type !== "note";
  useArticlePosition(folder.id, id, scroller, articleShown);
  const headings = useMemo(
    () => (item?.contentFormat === "markdown" && item.content ? articleHeadings(item.content) : []),
    [item?.content, item?.contentFormat],
  );

  // One contents list at a time: the rail wide, the folded list narrow. Wide enough and it gets its own track.
  // With the notes panel open the rail gives way, so the text keeps a readable width and the list folds up above it.
  const rail = useRailFits();
  const tocOn = articleShown && headings.length >= 2;
  const notesOn = articleShown && panel;
  // AI notes get a column beside the text when the window has room and the highlights panel is shut.
  // The contents then fold up above the text, as they do on a narrow window. Without room, notes sit under their paragraphs.
  const marginFits = useMarginFits();
  const noteCount = useNotes((s) => s.notes.reduce((n, x) => n + (x.item === id ? 1 : 0), 0));
  const marginOn = articleShown && marginFits && !notesOn && noteCount > 0;
  const railOn = rail && !notesOn && !marginOn;

  if (item === undefined) return <div className="item-stage"><main className="item-view" /></div>;
  if (!item || item.deleted) {
    const inTrash = !!item?.deleted && !item.purged;
    return (
      <main className="empty">
        <h2>{inTrash ? "This item is in the Trash" : "That item isn't here"}</h2>
        <p>{inTrash ? "Restore it to read it again." : "It may have been deleted or moved, or it hasn't synced to this device yet."}</p>
        <div className="row">
          {inTrash && (
            <button className="btn btn-primary" onClick={() => void restoreItem(folder.id, item.id)}>
              Restore
            </button>
          )}
          <button className={`btn ${inTrash ? "" : "btn-primary"}`} onClick={() => navigate({ name: "library", folder: folder.id })}>
            Back to {folder.name}
          </button>
        </div>
      </main>
    );
  }

  // A video and a playlist have screens of their own.
  if (item.type === "video") return <VideoView folder={folder} item={item} />;
  if (item.type === "playlist") return <PlaylistView folder={folder} item={item} />;

  const href = safeHref(item.sourceUrl);
  const isNote = item.type === "note";
  const byline = [item.author && `By ${item.author}`, item.siteName, item.source].filter(Boolean).join(" · ");
  const published = item.published && publishedDay(item.published);

  const asMarkdown = () => itemToMarkdown(item, quotes ?? []);
  const at = itemLocation(item);
  /**
   * Summary and Ask read a PDF's stored page text. If this device has the PDF but has not read its
   * text yet, read it first, which can take a while for a long PDF.
   */
  const askAi = async (mode: "summarize" | "ask") => {
    if (!item) return;
    // A saved article answers in notes beside its text. The ask bar is where a question is typed.
    if (articleShown) {
      if (mode === "summarize") return summarizeHere(item.id, scroller.current);
      const box = document.querySelector<HTMLInputElement>(".askbar input");
      box?.scrollIntoView({ block: "center", behavior: scrollMotion() });
      return box?.focus({ preventScroll: true });
    }
    let text = "";
    if (item.type === "pdf") {
      text = pageBlocks(await db.pageText.where("doc").equals(item.id).toArray());
      if (!text && (await db.blobs.get(item.id))) {
        toast("Reading the PDF's text. This can take a minute for a long PDF.");
        await indexDocument(folder.id, item.id);
        text = pageBlocks(await db.pageText.where("doc").equals(item.id).toArray());
      }
      if (!text) return toast("This PDF's text is not on this device yet. Open the PDF once to read it.");
    } else {
      text = savedText(item);
    }
    if (!text) return toast("This item has no saved text for AI to read.");
    // A PDF's citations open its pages; a saved article's open its paragraphs in this view.
    const askFrom =
      item.type === "pdf"
        ? { source: { folder: folder.id, doc: item.id } }
        : item.content?.trim()
          ? { article: { markdown: item.contentFormat === "markdown" } }
          : {};
    openAi(mode === "ask" ? { mode, title: item.title, text, key: item.id, ...askFrom } : { mode, title: item.title, text });
  };
  const openMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      ...(at
        ? (["inbox", "later", "archive"] as const)
            .filter((l) => l !== at)
            .map((l) => ({
              label: l === "inbox" ? "Move to Inbox" : l === "later" ? "Read later" : "Archive",
              icon: l === "inbox" ? <Inbox size={15} /> : l === "later" ? <Clock size={15} /> : <Archive size={15} />,
              run: () => void place(l),
            }))
        : []),
      { label: item.favorite ? "Remove from Favourites" : "Add to Favourites", icon: <Star size={15} />, run: () => void star(!item.favorite) },
      { label: "Rename", icon: <Pencil size={15} />, run: () => setDialog("rename") },
      { label: "Topics", icon: <Tag size={15} />, run: () => setDialog("topics") },
      { label: "Summarize with AI", icon: <Sparkles size={15} />, run: () => void askAi("summarize") },
      { label: "Ask about this item", icon: <MessageSquareText size={15} />, run: () => void askAi("ask") },
      {
        label: "Copy as Markdown",
        icon: <Copy size={15} />,
        run: async () => {
          try {
            await navigator.clipboard.writeText(asMarkdown());
            toast("Copied as Markdown.");
          } catch {
            toast("Couldn't copy. Download it instead.");
          }
        },
      },
      {
        label: "Download as Markdown",
        icon: <Download size={15} />,
        run: () => downloadMarkdown(markdownFilename(item.title), asMarkdown()),
      },
      { label: "Move to another folder", icon: <FolderInput size={15} />, run: () => setDialog("move") },
      {
        label: "Move to Trash",
        icon: <Trash2 size={15} />,
        danger: true,
        run: async () => {
          await removeItem(folder.id, item.id);
          navigate({ name: "library", folder: folder.id });
          toast(`Moved "${item.title}" to Trash.`, { action: { label: "Undo", run: () => void restoreItem(folder.id, item.id) } });
        },
      },
    ]);

  // Notes open and shut as they do in the PDF reader, and open on All.
  const togglePanel = () =>
    setPanel((p) => {
      localStorage.setItem("reader.panel", p ? "0" : "1");
      return !p;
    });
  const openNotes = () => {
    if (!panel) setPanelTab("all");
    togglePanel();
  };

  // A highlight in the list goes to its text, as in the PDF reader. A narrow window folds the panel away after it.
  const jumpTo = (a: Annotation) => {
    const range = ranges.current.get(a.id);
    if (range && scroller.current) scrollArticleTo(scroller.current, range);
    if (window.innerWidth < 900) setPanel(false);
  };
  const deleteWithUndo = async (a: Annotation) => {
    await deleteAnnotation(folder.id, a.id);
    toast("Highlight deleted", { action: { label: "Undo", run: () => void updateAnnotation(folder.id, a.id, { deleted: false }) } });
  };

  return (
    <div className="item-stage">
      <main className={`item-view${tocOn && railOn ? " has-toc" : ""}${marginOn ? " has-margin" : ""}`} ref={scroller}>
        <header className="topbar">
          <button className="icon-btn" aria-label={`Back to ${folder.name}`} onClick={() => navigate({ name: "library", folder: folder.id })}>
            <ArrowLeft size={20} />
          </button>
          <span className="muted">{folder.name}</span>
          <div className="spacer" />
          {at && (
            <button
              className="icon-btn"
              aria-label={at === "archive" ? "Move to Inbox" : "Archive"}
              title={at === "archive" ? "Move to Inbox (I)" : "Archive (E)"}
              onClick={() => void place(at === "archive" ? "inbox" : "archive")}
            >
              {at === "archive" ? <Inbox size={18} /> : <Archive size={18} />}
            </button>
          )}
          <button
            className={`icon-btn ${item.favorite ? "on" : ""}`}
            aria-label="Favourite"
            aria-pressed={!!item.favorite}
            title="Favourite (S)"
            onClick={() => void star(!item.favorite)}
          >
            <Star size={18} fill={item.favorite ? "currentColor" : "none"} />
          </button>
          {articleShown && (
            <button className={`icon-btn ${panel ? "on" : ""}`} aria-label="Notes" title="Notes" onClick={openNotes}>
              <NotebookPen size={18} />
              {!!quotes?.length && <span className="count">{quotes.length}</span>}
            </button>
          )}
          <button className="icon-btn" aria-label="Options" onClick={openMenu}>
            <Ellipsis size={18} />
          </button>
        </header>

        <div className="item-layout">
          <article className="item-body">
            <p className="item-kicker">
              <span className="type-pill">{TYPE_LABELS[item.type]}</span>
              {byline && <span className="muted">{byline}</span>}
              {href && (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {hostOf(href)} <ExternalLink size={13} />
                </a>
              )}
              {published && <span className="muted">Published {published}</span>}
              <span className="muted">Saved {dayOf(item.addedAt)}</span>
            </p>
            <h1 className="item-title">
              <button className="folder-title" title="Rename" onClick={() => setDialog("rename")}>
                {item.title}
              </button>
            </h1>
            <p className="item-topics">
              {item.topics?.map((t) => (
                <span key={t} className="chip on">
                  {t}
                </span>
              ))}
              <button className="link" onClick={() => setDialog("topics")}>
                {item.topics?.length ? "Change topics" : "Add topics"}
              </button>
            </p>

            {item.content && !isNote && (
              <section className="article" aria-label="Article">
                <div className="article-tools">
                  <span className="field-label">From the page</span>
                  <div className="spacer" />
                  <Listen scroller={scroller} />
                  <button
                    className={`icon-btn ${highlighter ? "on" : ""}`}
                    aria-label="Highlighter"
                    title="Highlighter: selecting text highlights it"
                    aria-pressed={highlighter}
                    onClick={() => setHighlighter((h) => !h)}
                  >
                    <Highlighter size={17} />
                  </button>
                  <button className="icon-btn" aria-label="Smaller text" title="Smaller text" disabled={prefs.size <= 14} onClick={() => setPrefs({ ...prefs, size: prefs.size - 1 })}>
                    <AArrowDown size={17} />
                  </button>
                  <button className="icon-btn" aria-label="Larger text" title="Larger text" disabled={prefs.size >= 26} onClick={() => setPrefs({ ...prefs, size: prefs.size + 1 })}>
                    <AArrowUp size={17} />
                  </button>
                </div>
                {tocOn && !railOn && <ArticleToc headings={headings} scroller={scroller} rail={false} />}
                <ArticleView
                  folder={folder}
                  item={item}
                  annotations={quotes ?? NO_QUOTES}
                  scroller={scroller}
                  highlighter={highlighter}
                  prefs={prefs}
                  ranges={ranges}
                  onPlaced={setPlaced}
                  inlineNotes={!marginOn}
                />
                {item.contentFormat !== "markdown" && !fetching && (
                  <p className="hint">Saved as plain text. Save the page again with Save to Engram to keep its formatting.</p>
                )}
                <AskBar item={item.id} scroller={scroller} />
              </section>
            )}

            {!!quotes?.length && (
              <section className="item-quotes" aria-label="Highlights">
                {quotes.map((q) => (
                  <figure key={q.id}>
                    <blockquote style={{ borderColor: q.color }}>{q.quote}</blockquote>
                    {q.note?.trim() && <figcaption>{q.note}</figcaption>}
                    <div className="quote-actions">
                      <button
                        className="icon-btn"
                        aria-label="Make a note from this"
                        title="Make a note from this"
                        onClick={async () => {
                          const note = await noteFromHighlight(folder.id, item, q.quote!);
                          navigate({ name: "item", folder: folder.id, item: note.id });
                        }}
                      >
                        <NotebookPen size={14} />
                      </button>
                      <button className="icon-btn" aria-label="Remove highlight" title="Remove highlight" onClick={() => void deleteAnnotation(folder.id, q.id)}>
                        <X size={14} />
                      </button>
                    </div>
                  </figure>
                ))}
              </section>
            )}

            <div className={`item-words ${isNote ? "is-note" : ""}`}>
              {!isNote && <span className="field-label">In your own words</span>}
              <Suspense fallback={<div className="md-editor md-loading" />}>
                <Editor
                  key={id}
                  value={item.body ?? ""}
                  onChange={onWords}
                  titles={() => titlesRef.current}
                  openWiki={(t) => void openWiki(t)}
                  highlights={(t) => highlightsOf(db, t)}
                  embed={(t) => resolveEmbed(db, t)}
                  // An empty note, or one just made (from a link or a highlight), opens ready to write.
                  autoFocus={isNote && (!item.body || Date.now() - item.addedAt < 10_000)}
                  label={isNote ? "Note" : "In your own words"}
                  placeholder={
                    isNote
                      ? "Write anything. Type / for headings, lists and to-dos, [[ to link to something you saved."
                      : "What did you notice? Why does it matter to you? No chatbot can give this back to you."
                  }
                />
              </Suspense>
            </div>

            <LocalGraph folder={folder.id} id={item.id} />

            {!!linkedFrom?.length && (
              <section className="backlinks" aria-label="Linked from">
                <h2>
                  <Link2 size={15} /> Linked from
                </h2>
                <ul>
                  {linkedFrom.map((b) => (
                    <li key={b.id}>
                      <a href={itemHref(folder.id, b)}>{b.title}</a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!item.content && item.description && !isNote && <p>{item.description}</p>}
            {!item.content && href && !isNote && (
              <p className="hint">
                {fetching ? "Getting the article from the page…" : "Only the link is saved. Open the page and use Save to Engram to keep its text too."}
              </p>
            )}
          </article>

          {tocOn && railOn && <ArticleToc headings={headings} scroller={scroller} rail />}
          {marginOn && <Margin item={item.id} scroller={scroller} />}
        </div>

        {menu.node}
        {dialog === "rename" && (
          <PromptDialog
            title="Rename"
            label="Title"
            initial={item.title}
            action="Rename"
            onClose={() => setDialog(null)}
            onSubmit={(t) => renameWithLinks(folder.id, item.id, t)}
          />
        )}
        {dialog === "move" && (
          <MoveDialog
            from={folder}
            items={[item]}
            onDone={(to) => navigate({ name: "item", folder: to.id, item: item.id }, { replace: true })}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === "topics" && (
          <TopicsDialog
            title={`Topics for "${item.title}"`}
            intro="Which of the things you're growing in does this belong to?"
            options={topics}
            initial={item.topics ?? []}
            onSave={async (chosen) => {
              await setItemTopics(folder.id, item.id, chosen);
              const added = chosen.filter((t) => !topics.includes(t));
              if (added.length) setHabit({ topics: [...topics, ...added] });
            }}
            onClose={() => setDialog(null)}
          />
        )}
      </main>
      {notesOn && (
        <NotesPanel
          item={item}
          annotations={quotes ?? NO_QUOTES}
          drawings={false}
          documentOrder={placed}
          tab={panelTab}
          onTab={setPanelTab}
          me={account?.login}
          onJump={jumpTo}
          onDelete={(a) => void deleteWithUndo(a)}
          onClose={togglePanel}
        />
      )}
    </div>
  );
}

// Empty lists are shared, so an effect that depends on them doesn't run again on every render.
const NO_QUOTES: Annotation[] = [];
const PREFS_KEY = "reader.article";
const DAY = { month: "short", day: "numeric", year: "numeric" } as const;

/** A date for the kicker. A date with no time is read as local time, so it doesn't slip back a day. */
/** A page's published date is midnight UTC when the page gave only a day, so show its UTC calendar day. */
function publishedDay(value: string): string | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString(undefined, { ...DAY, timeZone: "UTC" });
}

function dayOf(value: number | string): string | undefined {
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString(undefined, DAY);
}

/** Text size for articles, kept on this device. */
function useReadingPrefs(): [ReadingPrefs, (p: ReadingPrefs) => void] {
  const [prefs, set] = useState<ReadingPrefs>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ReadingPrefs>;
      return { size: typeof p.size === "number" ? Math.min(26, Math.max(14, p.size)) : 18, wide: p.wide === true };
    } catch {
      return { size: 18, wide: false };
    }
  });
  const save = (p: ReadingPrefs) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    set(p);
  };
  return [prefs, save];
}

/** The paragraph a citation names: the numbered one if its text still starts as the quote did, else the paragraph with that text. */
function findParagraph(root: HTMLElement, n: number, quote: string): HTMLElement | null {
  const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const key = words(plainAnswer(quote)).slice(0, 40);
  const paragraphs = [...root.querySelectorAll<HTMLElement>(".article-text [data-para]")];
  const numbered = paragraphs.find((el) => el.dataset.para === String(n)) ?? null;
  if (!key || (numbered && words(numbered.textContent ?? "").startsWith(key))) return numbered;
  return paragraphs.find((el) => words(el.textContent ?? "").startsWith(key)) ?? null;
}
