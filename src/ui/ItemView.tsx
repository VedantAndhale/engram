import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Ellipsis, ExternalLink, Pencil, Tag, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hostOf, safeHref, TYPE_LABELS } from "../capture/capture";
import { folderCtx } from "../folders/registry";
import { setHabit, useHabit } from "../habit/prefs";
import type { Folder } from "../model";
import { deleteAnnotation, removeItem, renameItem, restoreItem, setItemBody, setItemTopics } from "../store/actions";
import { navigate, toast } from "../store/ui";
import { PromptDialog, useMenu } from "./common";
import { TopicsDialog } from "./habit";

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

  // Your words are edited here and saved as you type; a synced change from another device
  // replaces the draft only while you aren't typing.
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<number>(undefined);
  const latest = useRef<string | null>(null);
  useEffect(() => {
    if (item && latest.current === null) setDraft(item.body ?? "");
  }, [item]);
  const onWords = (v: string) => {
    setDraft(v);
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
                <button className="icon-btn" aria-label="Remove highlight" onClick={() => void deleteAnnotation(folder.id, q.id)}>
                  <X size={14} />
                </button>
              </figure>
            ))}
          </section>
        )}

        <label className="item-words">
          <span>{isNote ? "Note" : "In your own words"}</span>
          <textarea
            value={draft ?? ""}
            rows={isNote ? 10 : 4}
            placeholder={isNote ? "Write in Markdown." : "What did you notice? Why does it matter to you? No chatbot can give this back to you."}
            onChange={(e) => onWords(e.target.value)}
          />
        </label>

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
