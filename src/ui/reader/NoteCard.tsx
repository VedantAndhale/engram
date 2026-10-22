import "../../styles/notes.css";
import { ArrowUp, ChevronsDownUp, CornerDownRight, Square, Trash2 } from "lucide-react";
import { forwardRef, useState, type CSSProperties } from "react";
import { openAi } from "../../ai/dialog";
import { download, stopDownload, useAiStatus } from "../../ai/engine";
import { firstSentence, plainAnswer } from "../../ai/format";
import { GEMMA } from "../../ai/model";
import { followUp, openNote, removeNote, retryNote, stopNote, threadKey, type Note, type NoteAction } from "../../ai/notes";
import { passageBudget, threadOf, useThreads, type Turn } from "../../ai/thread";
import { AnswerBody, type Cite } from "../../reader/markdown";
import { jumpToParagraph } from "../../store/ui";
import { useElapsed } from "../AiDialog";
import { CopyButton } from "../interior/CopyButton";
import { ProgressBar } from "../interior/ProgressBar";
import { SkeletonSwap } from "../interior/SkeletonSwap";

export const LABEL: Record<NoteAction, string> = {
  ask: "Question",
  summary: "Summary",
  explain: "Explain",
  define: "Define",
  simplify: "Simplify",
  counterpoint: "Counterpoint",
};

const GB = (GEMMA.bytes / 1e9).toFixed(1);

/** A preview of the paragraph a citation names, shown beside the chip while it is pointed at. */
interface Peek {
  n: number;
  text: string;
  rect: DOMRect;
}

/** A note beside a passage: closed it is a question and one line of answer; open it is the whole thread. */
export const NoteCard = forwardRef<
  HTMLElement,
  {
    note: Note;
    /** "margin" notes sit at `top` in the margin column; "inline" ones flow under their paragraph. */
    variant: "margin" | "inline";
    active: boolean;
    /** Where a margin note stands. Unknown until the margin is laid out, and hidden till then. */
    top?: number;
    /** A margin note's first placement: it appears in its place instead of gliding there. */
    fresh?: boolean;
  }
>(function NoteCard({ note, variant, active, top, fresh = false }, ref) {
  const thread = useThreads((s) => s.threads[threadKey(note)]) ?? threadOf(threadKey(note));
  const status = useAiStatus();
  const [draft, setDraft] = useState("");
  const [peek, setPeek] = useState<Peek | null>(null);
  const loadingSeconds = useElapsed(status.phase === "loading");

  const turns = thread.turns;
  const busy = !!note.pending;
  /** The model is on this device, so it can be deleted from here. */
  const onDevice = status.phase === "ready" || status.phase === "loaded" || status.phase === "loading";
  const label = LABEL[note.action];
  /** A note about the whole article sits beside the paragraph in view, but is not about that paragraph. */
  const whole = !note.anchor.quote;
  const where = whole ? "Whole article" : `¶${note.anchor.para}`;
  /** What the reader asked for, as the offer to download names it. */
  const asked = note.action === "ask" ? "question" : "request";
  const room = passageBudget(thread) > 0;
  const style: CSSProperties | undefined = variant === "margin" ? { top: Math.round(top ?? 0), ...(top === undefined ? { visibility: "hidden" } : null), ...(fresh ? { transition: "none" } : null) } : undefined;

  const jump = () => jumpToParagraph(note.item, note.anchor.para, note.anchor.quote ?? "");

  /** A turn's citations: the paragraphs its answer was given. Each opens that paragraph, and pointing at one previews it. */
  const citeFor = (turn: Turn): Cite | undefined =>
    turn.pages.length === 0
      ? undefined
      : {
          kind: "para",
          numbers: new Set(turn.pages),
          onOpen: (n) => jumpToParagraph(note.item, n, turn.quotes[n] ?? ""),
          peek: (n, el) => setPeek(el && turn.quotes[n] ? { n, text: turn.quotes[n], rect: el.getBoundingClientRect() } : null),
        };

  /** What Copy puts on the clipboard: the passage, then each question and answer with the coverage line. */
  const copyText = [
    note.anchor.quote ? `“${note.anchor.quote}”` : null,
    ...turns.map((t, i) => [i > 0 || note.action === "ask" ? `Q: ${t.question}` : null, plainAnswer(t.answer), t.note].filter(Boolean).join("\n\n")),
  ]
    .filter(Boolean)
    .join("\n\n");

  const submit = () => {
    const q = draft.trim();
    if (!q || busy) return;
    followUp(note.id, q);
    setDraft("");
  };

  const first = turns[0];
  const heading = note.action === "ask" ? note.question : null;

  // Closed: what it is about, and under it the first sentence of the answer.
  if (!active) {
    const line = first ? firstSentence(first.answer) : "";
    return (
      <article
        ref={ref}
        data-note={note.id}
        role="button"
        tabIndex={0}
        aria-label={`${heading ?? label}, ${whole ? "about the whole article" : `paragraph ${note.anchor.para}`}. Open note.`}
        className={`note note-${variant} is-closed`}
        style={style}
        onClick={() => openNote(note.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openNote(note.id);
          }
        }}
      >
        <div className="note-line">
          <span className="note-title">
            {heading ?? (
              <>
                <span className="note-label">{label}</span>
                {note.anchor.quote && <span className="note-snip">{` “${note.anchor.quote}”`}</span>}
              </>
            )}
          </span>
          {turns.length > 1 && <span className="note-count">+{turns.length - 1}</span>}
          <span className="note-count">{where}</span>
        </div>
        {line ? <p className="note-gist">{line}</p> : busy ? <span className="note-writing" role="status" aria-label="Writing" /> : note.waiting ? <p className="note-gist">Waiting for the model</p> : null}
      </article>
    );
  }

  return (
    <article
      ref={ref}
      data-note={note.id}
      aria-label={`${label} note ${whole ? "on the whole article" : `on paragraph ${note.anchor.para}`}`}
      className={`note note-${variant} is-open`}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target as HTMLElement).closest("input")) {
          e.stopPropagation();
          openNote(null);
        }
      }}
    >
      <header className="note-head">
        <span className="note-label">{label}</span>
        {whole ? (
          <span className="note-count">{where}</span>
        ) : (
          <button type="button" className="cite" onClick={jump} aria-label={`Go to paragraph ${note.anchor.para}`} title="Show in the text">
            {where}
          </button>
        )}
        {turns.length > 1 && <span className="note-count">{turns.length - 1} follow-up{turns.length > 2 ? "s" : ""}</span>}
        <button type="button" className="icon-btn note-fold" aria-label="Collapse note" title="Collapse (Esc)" onClick={() => openNote(null)}>
          <ChevronsDownUp size={15} />
        </button>
      </header>

      {note.anchor.quote && note.action !== "ask" && <blockquote className="note-passage">{note.anchor.quote}</blockquote>}
      {heading && <p className="note-q">{heading}</p>}

      <div className="note-content">
        {turns.map((t, i) => (
          <div key={i} className="note-turn">
            {i > 0 && (
              <p className="note-q note-q-follow">
                <CornerDownRight size={14} aria-hidden /> {t.question}
              </p>
            )}
            <div className="note-answer">
              <AnswerBody text={t.answer} cite={citeFor(t)} />
            </div>
            {t.stopped && <p className="hint">You stopped this answer.</p>}
            {t.note && <p className="hint">{t.note}</p>}
          </div>
        ))}

        {note.pending && (
          <div className="note-turn">
            {turns.length > 0 && (
              <p className="note-q note-q-follow">
                <CornerDownRight size={14} aria-hidden /> {note.pending.question}
              </p>
            )}
            <SkeletonSwap ready={!!note.pending.text} label="Answer">
              {note.pending.text ? (
                <div className="note-answer" aria-live="polite">
                  <AnswerBody text={note.pending.text} />
                </div>
              ) : null}
            </SkeletonSwap>
            {!note.pending.text && status.phase === "loading" && (
              <p className="hint note-loading">Loading the model… {loadingSeconds} s. The first load after a restart can take a few minutes. Keep reading.</p>
            )}
          </div>
        )}

        {note.waiting && (
          <div className="note-setup">
            {status.phase === "downloading" ? (
              <>
                <ProgressBar
                  label={`Downloading ${GEMMA.name}`}
                  value={status.progress && status.progress.received > 0 ? (status.progress.received / status.progress.total) * 100 : null}
                  pendingLabel="Starting"
                  completeLabel="Downloaded"
                />
                <p className="hint">Keep reading. Your {asked} is saved and will be answered when it is ready.</p>
                <div className="note-actions">
                  <button className="btn" onClick={stopDownload}>
                    Stop download
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  Your {asked} is saved. To answer it, Engram needs a language model on this device: {GEMMA.name}, about {GB} GB, downloaded once from Hugging Face, which takes
                  roughly 9 minutes on a typical connection.
                </p>
                <p className="hint">After that it runs here and the text never leaves this device. You can keep reading while it downloads, and remove it any time.</p>
                {status.message && <p className="hint">{status.message}</p>}
                <div className="note-actions">
                  <button className="btn btn-primary" onClick={() => void download()}>
                    Download and answer
                  </button>
                  <button className="btn" onClick={() => removeNote(note.id)}>
                    Not now
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {note.error && (
          <div className="note-error">
            <p>{note.error}</p>
            {turns.length === 0 && !busy && status.phase !== "unsupported" && (
              <div className="note-actions">
                <button className="btn" onClick={() => retryNote(note.id)}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="note-foot">
        {busy ? (
          <button className="btn" onClick={() => stopNote(note.id)}>
            <Square size={12} fill="currentColor" aria-hidden /> Stop
          </button>
        ) : (
          <>
            {turns.length > 0 && <CopyButton iconOnly value={copyText} />}
            <button className="icon-btn note-trash" aria-label="Delete note" title="Delete note" onClick={() => removeNote(note.id)}>
              <Trash2 size={15} />
            </button>
            {onDevice ? (
              <button className="link note-manage note-model-delete" onClick={() => openAi({ mode: "remove" })}>
                Delete model
              </button>
            ) : (
              <button className="link note-manage" onClick={() => openAi({ mode: "settings" })}>
                AI on this device
              </button>
            )}
          </>
        )}
      </footer>

      {turns.length > 0 && !note.waiting &&
        (room ? (
          <form
            className="note-ask"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask a follow-up" aria-label="Ask a follow-up" disabled={busy} />
            <button className="icon-btn" type="submit" aria-label="Send" disabled={busy || !draft.trim()}>
              <ArrowUp size={16} />
            </button>
          </form>
        ) : (
          <p className="hint">This note has used its room in the model's window. Ask in a new note to keep going.</p>
        ))}

      {turns.length > 0 && <p className="hint note-trust">Written by {GEMMA.name} on this device. Check it against the article.</p>}

      {peek && (
        <div
          className="note-peek"
          role="tooltip"
          style={{
            left: Math.max(8, Math.min(peek.rect.left, window.innerWidth - 336)),
            top: peek.rect.bottom + 8 + 150 > window.innerHeight ? Math.max(8, peek.rect.top - 8 - 150) : peek.rect.bottom + 8,
          }}
        >
          <span className="note-peek-n">¶{peek.n}</span>
          {peek.text.length > 320 ? `${peek.text.slice(0, 320).trimEnd()}…` : peek.text}
        </div>
      )}
    </article>
  );
});
