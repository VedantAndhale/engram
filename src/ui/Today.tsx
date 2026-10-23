import { useLiveQuery } from "dexie-react-hooks";
import { itemHref } from "../capture/capture";
import { BellRing, BookmarkPlus, BookOpen, CloudUpload, Menu as MenuIcon, NotebookPen, Pencil, Plus, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { folderCtx, visibleFolders } from "../folders/registry";
import { setHabit, useHabit } from "../habit/prefs";
import { allCards, rate, retire, saveWords, undoReview, weekStats, type Card, type Undo } from "../habit/review";
import { startOfDay, todaysShare } from "../habit/schedule";
import { timeAgo } from "../lib/util";
import { dailyNote } from "../notes/notes";
import type { ItemType } from "../model";
import { navigate, openQuickAdd } from "../store/ui";
import { useAccount } from "../sync/account";
import { BookmarkletCard } from "./Capture";
import { partlyRead } from "../reader/articlePosition";
import { ReminderDialog, TopicsDialog } from "./habit";
import { AgentInbox } from "./Inbox";
import { libraryOf } from "../folders/library";

// The Markdown editor, loaded when a review asks for a note (as ItemView does).
const Editor = lazy(() => import("../editor/Editor"));

const PER_SESSION = 3;

export function Today({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const cards = useLiveQuery(allCards, []);
  const account = useAccount((a) => a.account);
  const { topics, reminder, backupDismissed } = useHabit();
  const [dialog, setDialog] = useState<"reminder" | "topics" | null>(null);

  // The session is fixed when it starts, so a card doesn't jump away while you're writing on it.
  // A new day starts a new one, unless you're part way through a card.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [pos, setPos] = useState(0);
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  // The last rating or "don't show again", which can be taken back.
  const [last, setLast] = useState<Undo | null>(null);
  const startSession = (all: Card[]) => {
    const now = Date.now();
    setQueue(todaysShare(all, now).today.slice(0, PER_SESSION).map((c) => c.key));
    setPos(0);
    setDay(startOfDay(now));
  };
  useEffect(() => {
    if (cards && !queue) startSession(cards);
  }, [cards, queue]);

  // Look again every minute and whenever the app comes back to the front, so an app left open
  // overnight notices the new day and highlights that came due since.
  const [, setTick] = useState(0);
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && setTick((t) => t + 1);
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, []);
  useEffect(() => {
    if (cards && queue && startOfDay(Date.now()) !== day && (pos === 0 || pos >= queue.length)) startSession(cards);
  });

  const takeBack = async () => {
    if (!last || !queue) return;
    setLast(null);
    await undoReview(last);
    const i = queue.indexOf(last.card.key);
    if (i >= 0) setPos(i);
    else {
      setQueue([last.card.key, ...queue.slice(pos)]);
      setPos(0);
    }
  };

  const library = useLiveQuery(async () => {
    const out: { folder: string; hash: string; type: ItemType; pdf: boolean; title: string; page: number; pages: number; at: number; topics: string[]; articleRead?: number }[] = [];
    for (const f of await visibleFolders()) {
      const { db } = folderCtx(f.id);
      const pos = new Map((await db.positions.toArray()).map((p) => [p.doc, p]));
      for (const d of await db.items.toArray()) {
        if (d.deleted) continue;
        const p = pos.get(d.id);
        // An article part way through is read by its fraction, not by page.
        out.push({
          folder: f.id,
          hash: d.id,
          type: d.type,
          pdf: d.type === "pdf",
          title: d.title,
          page: p?.page ?? 1,
          pages: d.pages ?? 1,
          at: p?.updatedAt ?? 0,
          topics: d.topics ?? [],
          // A video's place is its watched fraction too; it isn't an article, so Keep reading leaves it out.
          articleRead: d.type !== "video" && partlyRead(p) ? p.offset : undefined,
        });
      }
    }
    return out;
  }, []);

  if (!cards || !library || !queue) return <main className="today" />;

  const now = Date.now();
  // At most a day's worth is offered; a bigger backlog comes in over the following days.
  const share = todaysShare(cards, now);
  const due = share.today.length;
  const current = cards.find((c) => c.key === queue[pos]);
  const stats = weekStats(cards, now);
  // The last thing read: a PDF with a saved position, or an article part way through.
  const lastRead = library.filter((d) => (d.pdf && d.at) || d.articleRead !== undefined).sort((a, b) => b.at - a.at)[0];
  const growth = topics.map((t) => {
    const docs = library.filter((d) => d.topics.includes(t));
    const hashes = new Set(docs.map((d) => d.hash));
    return { topic: t, docs: docs.length, highlights: cards.filter((c) => hashes.has(c.doc.id)).length };
  });
  // From the first thing saved: a browser can clear a site's storage (Safari after a week away).
  const offerBackup = !account && !backupDismissed && library.length > 0;

  return (
    <main className="today">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <h1>Today</h1>
        <div className="spacer" />
        <button className="btn btn-primary" title="Save a link, a quote or a note (N)" onClick={() => openQuickAdd()}>
          <Plus size={16} /> Save
        </button>
      </header>

      <div className="today-body">
        <p className="today-date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>

        <section className="today-card review" aria-label="Review">
          {current ? (
            <ReviewCard
              key={current.key}
              card={current}
              index={pos}
              total={queue.length}
              onUndo={last ? () => void takeBack() : undefined}
              onDone={(undo) => {
                setLast(undo);
                setPos((p) => p + 1);
              }}
            />
          ) : (
            <ReviewDone
              reviewed={pos}
              moreDue={due}
              waiting={share.waiting}
              hasAny={cards.some((c) => !c.retired)}
              onMore={() => startSession(cards)}
              onUndo={last ? () => void takeBack() : undefined}
            />
          )}
        </section>

        <AgentInbox />

        <div className="today-grid">
          <section className="today-card">
            <h2>
              <BookOpen size={17} /> Keep reading
            </h2>
            {lastRead ? (
              <>
                <a className="continue" href={itemHref(lastRead.folder, { id: lastRead.hash, type: lastRead.type }, lastRead.page)}>
                  <strong>{lastRead.title}</strong>
                  <span className="muted">
                    {lastRead.articleRead !== undefined ? `${Math.round(lastRead.articleRead * 100)}% read` : `Page ${lastRead.page} of ${lastRead.pages}`} ·{" "}
                    {timeAgo(lastRead.at)}
                  </span>
                </a>
                <p className="hint">When a sentence matters, highlight it and write one line about why.</p>
              </>
            ) : (
              <>
                <p className="muted">Add something you want to understand better. A paper, a chapter, an essay saved as PDF.</p>
                <button className="btn btn-primary" onClick={() => navigate({ name: "library" })}>
                  Go to your library
                </button>
              </>
            )}
          </section>

          <section className="today-card">
            <h2>
              <Sparkles size={17} /> This week
            </h2>
            <ul className="stats">
              <li>
                <strong>{stats.saved}</strong> highlight{stats.saved === 1 ? "" : "s"} kept
              </li>
              <li>
                <strong>{stats.ownWords}</strong> in your own words
              </li>
              <li>
                <strong>{stats.reviewed}</strong> reviewed
              </li>
            </ul>
            <p className="hint">No streaks to keep. Every day you show up adds to what you know.</p>
          </section>

          <section className="today-card">
            <h2>
              <Pencil size={17} /> Your topics
              <button className="btn btn-small push" onClick={() => setDialog("topics")}>
                Edit
              </button>
            </h2>
            {growth.length ? (
              <ul className="growth">
                {growth.map((g) => (
                  <li key={g.topic}>
                    <span>{g.topic}</span>
                    <span className="muted">
                      {g.docs} item{g.docs === 1 ? "" : "s"} · {g.highlights} highlight{g.highlights === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Pick what you want to grow in. Tag what you save with a topic.</p>
            )}
          </section>

          <section className="today-card">
            <h2>
              <NotebookPen size={17} /> Today's note
            </h2>
            <p className="muted">A page for today: what you read, what you thought, what to look into next.</p>
            <button
              className="btn"
              onClick={async () => {
                const folders = await visibleFolders();
                const folder = libraryOf(folders);
                if (!folder) return;
                const note = await dailyNote(folder.id);
                navigate({ name: "item", folder: folder.id, item: note.id });
              }}
            >
              Write today's note
            </button>
          </section>

          <section className="today-card">
            <h2>
              <BellRing size={17} /> Daily reminder
            </h2>
            {reminder ? (
              <p className="muted">
                Every day at {reminder}, from your calendar.{" "}
                <button className="link" onClick={() => setDialog("reminder")}>
                  Change
                </button>
              </p>
            ) : (
              <>
                <p className="muted">A cue at the same time each day is the easiest way to build the habit.</p>
                <button className="btn" onClick={() => setDialog("reminder")}>
                  Set a reminder
                </button>
              </>
            )}
          </section>

          <section className="today-card">
            <h2>
              <BookmarkPlus size={17} /> Save from anywhere
            </h2>
            <BookmarkletCard />
          </section>

          {offerBackup && (
            <section className="today-card">
              <h2>
                <CloudUpload size={17} /> Keep it safe
              </h2>
              <p className="muted">
                Everything is in this browser only, and browsers can clear it. Connect GitHub to keep a private copy and use it on your
                other devices.
              </p>
              <div className="row">
                <button className="btn" onClick={() => navigate({ name: "setup" })}>
                  Back up to GitHub
                </button>
                <button className="link" onClick={() => setHabit({ backupDismissed: true })}>
                  Not now
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      {dialog === "reminder" && <ReminderDialog onClose={() => setDialog(null)} />}
      {dialog === "topics" && (
        <TopicsDialog
          title="Your topics"
          intro="What do you want to grow in? These show up when you tag documents."
          options={[...new Set(library.flatMap((d) => d.topics))]}
          initial={topics}
          onSave={(t) => setHabit({ topics: t })}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

function ReviewCard({
  card,
  index,
  total,
  onDone,
  onUndo,
}: {
  card: Card;
  index: number;
  total: number;
  /** The card is finished with: rated or retired (with how to take it back), or skipped (null). */
  onDone: (undo: Undo | null) => void;
  /** Take back the previous card's rating, when there is one. */
  onUndo?: () => void;
}) {
  const [words, setWords] = useState(card.note ?? "");
  const [writing, setWriting] = useState(!card.note);
  const [busy, setBusy] = useState(false);

  // Your words are saved as you type, after a short pause, and whenever the card goes away, so
  // following the link to the source (or going anywhere else) never loses them.
  const latest = useRef(card);
  latest.current = card;
  const pending = useRef<string | null>(null);
  const timer = useRef<number>(undefined);
  const flush = async () => {
    clearTimeout(timer.current);
    const text = pending.current;
    if (text === null) return;
    pending.current = null;
    await saveWords(latest.current, text);
  };
  const onWords = (v: string) => {
    setWords(v);
    pending.current = v;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };
  useEffect(() => {
    const leave = () => void flush();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async (act: () => Promise<Undo | null>) => {
    setBusy(true);
    await flush();
    onDone(await act());
  };
  const prompt = card.note ? "Rewrite it, now that you've had time with it" : "Why does this matter? Say it in your own words.";

  return (
    <>
      <div className="review-head">
        <span className="muted">
          Review {index + 1} of {total}
          {onUndo && (
            <>
              {" · "}
              <button className="link" onClick={onUndo} title="Take back the last answer">
                Undo
              </button>
            </>
          )}
        </span>
        <a className="muted" href={itemHref(card.folder.id, card.doc, card.parts[0].page)}>
          {card.doc.title}
          {card.parts[0].page > 0 && ` · p. ${card.parts[0].page}`}
        </a>
      </div>
      <blockquote className="review-quote">{card.quote}</blockquote>
      {!writing ? (
        <div className="review-words">
          <span className="muted">In your words</span>
          <p>{words}</p>
          <button className="link" onClick={() => setWriting(true)}>
            Rewrite
          </button>
        </div>
      ) : (
        <label className="review-write">
          <span className="muted">{prompt}</span>
          <div className="note-editor">
            <Suspense fallback={<div className="md-editor md-loading" />}>
              <Editor
                value={words}
                onChange={onWords}
                titles={() => []}
                openWiki={() => {}}
                highlights={async () => []}
                embed={async () => null}
                placeholder="One line is enough…"
                label={`${prompt} Your words on: ${card.quote.slice(0, 80)}`}
              />
            </Suspense>
          </div>
        </label>
      )}
      <div className="review-actions">
        <button className="link" disabled={busy} onClick={() => void finish(() => retire(card))} title="Keep the highlight, but stop bringing it back here">
          Don't show again
        </button>
        <button className="link" disabled={busy} onClick={() => void finish(async () => null)} title="Leave it for another time">
          Skip
        </button>
        <div className="spacer" />
        <button className="btn" disabled={busy} onClick={() => void finish(() => rate(card, false))} title="See it again tomorrow">
          Hazy
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void finish(() => rate(card, true))} title="See it again in a few days">
          Still clear
        </button>
      </div>
    </>
  );
}

function ReviewDone({
  reviewed,
  moreDue,
  waiting,
  hasAny,
  onMore,
  onUndo,
}: {
  reviewed: number;
  moreDue: number;
  /** Due, but past today's limit: they come in over the following days. */
  waiting: number;
  hasAny: boolean;
  onMore: () => void;
  onUndo?: () => void;
}) {
  if (!hasAny)
    return (
      <div className="review-empty">
        <h2>Nothing to review yet</h2>
        <p className="muted">Highlights you make come back here a day later, so they stick instead of fading.</p>
      </div>
    );
  return (
    <div className="review-empty">
      <h2>{reviewed ? "Done for today" : "You're all caught up"}</h2>
      <p className="muted">
        {moreDue
          ? `${moreDue} more highlight${moreDue === 1 ? " is" : "s are"} ready if you have a few more minutes.`
          : "Your highlights will come back when they're due. Read something new, or come back tomorrow."}
        {waiting > 0 && ` ${waiting} more ${waiting === 1 ? "is" : "are"} waiting, and will come in over the next few days so no day gets long.`}
      </p>
      {moreDue > 0 && (
        <button className="btn" onClick={onMore}>
          Review {Math.min(PER_SESSION, moreDue)} more
        </button>
      )}
      {onUndo && (
        <button className="link" onClick={onUndo} title="Take back the last answer">
          Undo the last one
        </button>
      )}
    </div>
  );
}
