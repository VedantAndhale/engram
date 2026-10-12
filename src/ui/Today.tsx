import { useLiveQuery } from "dexie-react-hooks";
import { itemHref } from "../capture/capture";
import { BellRing, BookmarkPlus, BookOpen, CloudUpload, Menu as MenuIcon, NotebookPen, Pencil, Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { folderCtx, visibleFolders } from "../folders/registry";
import { setHabit, useHabit } from "../habit/prefs";
import { allCards, rate, saveWords, weekStats, type Card } from "../habit/review";
import { timeAgo } from "../lib/util";
import { dailyNote } from "../notes/notes";
import type { ItemType } from "../model";
import { lastFolder, navigate, openQuickAdd } from "../store/ui";
import { useAccount } from "../sync/account";
import { BookmarkletCard } from "./Capture";
import { partlyRead } from "../reader/articlePosition";
import { ReminderDialog, TopicsDialog } from "./habit";
import { AgentInbox } from "./Inbox";

const PER_SESSION = 3;
const WEEK = 7 * 86_400_000;

export function Today({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const cards = useLiveQuery(allCards, []);
  const account = useAccount((a) => a.account);
  const { topics, reminder, firstUse } = useHabit();
  const [dialog, setDialog] = useState<"reminder" | "topics" | null>(null);

  // The session is fixed when the page opens, so a card doesn't jump away while you're writing on it.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [pos, setPos] = useState(0);
  const startSession = (all: Card[]) => {
    const now = Date.now();
    setQueue(all.filter((c) => c.due <= now).sort((a, b) => a.due - b.due).slice(0, PER_SESSION).map((c) => c.key));
    setPos(0);
  };
  useEffect(() => {
    if (cards && !queue) startSession(cards);
  }, [cards, queue]);

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
          articleRead: partlyRead(p) ? p.offset : undefined,
        });
      }
    }
    return out;
  }, []);

  if (!cards || !library || !queue) return <main className="today" />;

  const now = Date.now();
  const due = cards.filter((c) => c.due <= now).length;
  const current = cards.find((c) => c.key === queue[pos]);
  const stats = weekStats(cards, now);
  // The last thing read: a PDF with a saved position, or an article part way through.
  const lastRead = library.filter((d) => (d.pdf && d.at) || d.articleRead !== undefined).sort((a, b) => b.at - a.at)[0];
  const growth = topics.map((t) => {
    const docs = library.filter((d) => d.topics.includes(t));
    const hashes = new Set(docs.map((d) => d.hash));
    return { topic: t, docs: docs.length, highlights: cards.filter((c) => hashes.has(c.doc.id)).length };
  });
  const offerBackup = !account && now - firstUse > WEEK && cards.length > 0;

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
              onRated={() => setPos((p) => p + 1)}
            />
          ) : (
            <ReviewDone
              reviewed={pos}
              moreDue={due}
              hasAny={cards.length > 0}
              onMore={() => startSession(cards)}
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
                const folder = folders.find((f) => f.id === lastFolder()) ?? folders[0];
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
              <p className="muted">Everything lives on this device. Connect GitHub to back it up privately and use it on your other devices.</p>
              <button className="btn" onClick={() => navigate({ name: "setup" })}>
                Back up to GitHub
              </button>
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

function ReviewCard({ card, index, total, onRated }: { card: Card; index: number; total: number; onRated: () => void }) {
  const [words, setWords] = useState(card.note ?? "");
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = words.trim() !== (card.note ?? "").trim();

  const finish = async (clear: boolean) => {
    setBusy(true);
    if (changed) await saveWords(card, words);
    await rate(card, clear);
    onRated();
  };

  return (
    <>
      <div className="review-head">
        <span className="muted">
          Review {index + 1} of {total}
        </span>
        <a className="muted" href={itemHref(card.folder.id, card.doc, card.parts[0].page)}>
          {card.doc.title}
          {card.parts[0].page > 0 && ` · p. ${card.parts[0].page}`}
        </a>
      </div>
      <blockquote className="review-quote">{card.quote}</blockquote>
      {card.note && !writing ? (
        <div className="review-words">
          <span className="muted">In your words</span>
          <p>{words}</p>
          <button className="link" onClick={() => setWriting(true)}>
            Rewrite
          </button>
        </div>
      ) : (
        <label className="review-write">
          <span className="muted">{card.note ? "Rewrite it, now that you've had time with it" : "Why does this matter? Say it in your own words."}</span>
          <textarea rows={3} value={words} placeholder="One line is enough…" onChange={(e) => setWords(e.target.value)} />
        </label>
      )}
      <div className="review-actions">
        <button className="btn" disabled={busy} onClick={() => void finish(false)} title="See it again tomorrow">
          Hazy
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void finish(true)} title="See it again in a few days">
          Still clear
        </button>
      </div>
    </>
  );
}

function ReviewDone({ reviewed, moreDue, hasAny, onMore }: { reviewed: number; moreDue: number; hasAny: boolean; onMore: () => void }) {
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
      </p>
      {moreDue > 0 && (
        <button className="btn" onClick={onMore}>
          Review {Math.min(PER_SESSION, moreDue)} more
        </button>
      )}
    </div>
  );
}
