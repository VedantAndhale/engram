import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Ellipsis, ExternalLink, Link2, NotebookPen, Pencil, Tag, Trash2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { hostOf, itemHref, safeHref, TYPE_LABELS } from "../capture/capture";
import { folderCtx } from "../folders/registry";
import { backlinks, noteFromHighlight, openOrCreate } from "../notes/notes";
import { setHabit, useHabit } from "../habit/prefs";
import type { Folder } from "../model";
import { deleteAnnotation, removeItem, renameItem, restoreItem, setItemBody, setItemTopics } from "../store/actions";
import { navigate, toast } from "../store/ui";
import { PromptDialog, useMenu } from "./common";
import { TopicsDialog } from "./habit";

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
  const [dialog, setDialog] = useState<"rename" | "topics" | null>(null);
  const menu = useMenu();

  const linkedFrom = useLiveQuery(async () => (item ? backlinks(db, item.title, item.id) : []), [item?.title, item?.id]);
  const titles = useLiveQuery(async () => (await db.items.toArray()).filter((i) => !i.deleted && i.id !== id).map((i) => i.title), [id]);
  const titlesRef = useRef<string[]>([]);
  titlesRef.current = titles ?? [];

  const openWiki = async (title: string) => {
    const target = await openOrCreate(folder.id, title);
    navigate(target.type === "pdf" ? { name: "reader", folder: folder.id, doc: target.id } : { name: "item", folder: folder.id, item: target.id });
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

  useEffect(() => {
    if (item) document.title = `${item.title} · Engram`;
    return () => void (document.title = "Engram");
  }, [item?.title]);

  if (item === undefined) return <main className="item-view" />;
  if (!item || item.deleted) {
    return (
      <main className="empty">
        <h2>That item isn't here</h2>
        <p>It may have been removed, or it hasn't synced to this device yet.</p>
        <button className="btn btn-primary" onClick={() => navigate({ name: "library", folder: folder.id })}>
          Back to {folder.name}
        </button>
      </main>
    );
  }

  const href = safeHref(item.sourceUrl);
  const isNote = item.type === "note";

  const openMenu = (e: React.MouseEvent) =>
    menu.open(e, [
      { label: "Rename", icon: <Pencil size={15} />, run: () => setDialog("rename") },
      { label: "Topics", icon: <Tag size={15} />, run: () => setDialog("topics") },
      {
        label: "Remove",
        icon: <Trash2 size={15} />,
        danger: true,
        run: async () => {
          await removeItem(folder.id, item.id);
          navigate({ name: "library", folder: folder.id });
          toast(`Removed "${item.title}".`, { action: { label: "Undo", run: () => void restoreItem(folder.id, item.id) } });
        },
      },
    ]);

  return (
    <main className="item-view">
      <header className="topbar">
        <button className="icon-btn" aria-label={`Back to ${folder.name}`} onClick={() => navigate({ name: "library", folder: folder.id })}>
          <ArrowLeft size={20} />
        </button>
        <span className="muted">{folder.name}</span>
        <div className="spacer" />
        <button className="icon-btn" aria-label="Options" onClick={openMenu}>
          <Ellipsis size={18} />
        </button>
      </header>

      <article className="item-body">
        <p className="item-kicker">
          <span className="type-pill">{TYPE_LABELS[item.type]}</span>
          {href && (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {hostOf(href)} <ExternalLink size={13} />
            </a>
          )}
          <span className="muted">Saved {new Date(item.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
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
              autoFocus={isNote && !item.body}
              label={isNote ? "Note" : "In your own words"}
              placeholder={
                isNote
                  ? "Write anything. Type / for headings, lists and to-dos, [[ to link to something you saved."
                  : "What did you notice? Why does it matter to you? No chatbot can give this back to you."
              }
            />
          </Suspense>
        </div>

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

        {item.content ? (
          <details className="item-content">
            <summary>Saved from the source</summary>
            <p className="hint">The page's own words, as saved. Kept apart from yours.</p>
            <div className="saved-text">{item.content}</div>
          </details>
        ) : (
          href &&
          !isNote && <p className="hint">Only the link is saved. Open the page and use Save to Engram to keep its text too.</p>
        )}
      </article>

      {menu.node}
      {dialog === "rename" && (
        <PromptDialog
          title="Rename"
          label="Title"
          initial={item.title}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={(t) => renameItem(folder.id, item.id, t)}
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
  );
}
