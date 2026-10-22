import { useMemo, useRef, useState } from "react";
import { closeAi, STARTER_QUESTIONS, type AskTask } from "../ai/dialog";
import { dropThread, generate } from "../ai/engine";
import { GEMMA } from "../ai/model";
import { plainAnswer } from "../ai/format";
import { clearThread, passageBudget, roomTokens, threadOf, useThreads, type Turn } from "../ai/thread";
import { FULL, answerTurn, turnContext } from "../ai/turn";
import { AnswerBody, type Cite } from "../reader/markdown";
import { navigate, jumpToParagraph } from "../store/ui";
import { CopyButton } from "./interior/CopyButton";

/** The Ask dialog's conversation: the item's questions and answers, with a box for the next one. */
export function AskThread({ task }: { task: AskTask }) {
  const thread = useThreads((s) => s.threads[task.key]) ?? threadOf(task.key);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<{ question: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answering = useRef<AbortController | null>(null);

  const src = task.source;
  const ctx = useMemo(
    () => turnContext({ key: task.key, title: task.title, text: task.text, page: !!src, article: task.article }),
    [task.key, task.title, task.text, src, task.article],
  );
  /** What a citation names: a PDF's page, or an article's paragraph. Null when the item has neither. */
  const cite = ctx.cite;
  const textKey = ctx.textKey;
  const full = thread.turns.length > 0 && passageBudget(thread) === 0;

  const send = async (q: string) => {
    const asked = q.trim();
    if (!asked || busy) return;
    if (passageBudget(threadOf(task.key)) === 0) return setError(FULL);
    setBusy(true);
    setError(null);
    setQuestion("");
    setPending({ question: asked, text: "" });
    const ctl = new AbortController();
    answering.current = ctl;
    const message = await answerTurn(ctx, { kind: "ask", question: asked }, generate, (piece) => setPending((p) => (p ? { ...p, text: p.text + piece } : p)), ctl.signal);
    if (message) setError(message);
    setPending(null);
    setBusy(false);
    answering.current = null;
  };

  const startNew = () => {
    dropThread(task.key);
    clearThread(task.key);
    setError(null);
  };

  /** The citations of one turn: its pages or paragraphs, each opening the reader or the paragraph. */
  const citeFor = (turn: Turn): Cite | undefined => {
    if (!cite || turn.pages.length === 0) return undefined;
    return {
      kind: cite,
      numbers: new Set(turn.pages),
      onOpen: (n: number) => {
        closeAi();
        if (cite === "page" && src) {
          navigate({ name: "reader", folder: src.folder, doc: src.doc, page: n });
        } else {
          jumpToParagraph(task.key, n, turn.quotes[n] ?? "");
        }
      },
    };
  };

  return (
    <>
      {thread.turns.length === 0 && !pending && (
        <div className="ai-chips">
          {STARTER_QUESTIONS.map((q) => (
            <button key={q} className="link" disabled={busy} onClick={() => void send(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {thread.turns.map((turn, i) => (
        <div className="ai-turn" key={i}>
          <p className="ai-question">{turn.question}</p>
          <div className="ai-output">
            <AnswerBody text={turn.answer} cite={citeFor(turn)} />
          </div>
          {turn.stopped && <p className="hint">You stopped this answer.</p>}
          {turn.textKey !== textKey && (
            <p className="hint">This item changed since this answer. A paragraph link goes to the paragraph the answer was based on, if it is still there.</p>
          )}
          {turn.note && <p className="hint">{turn.note}</p>}
          <div className="ai-actions">
            <CopyButton value={[plainAnswer(turn.answer), turn.note].filter(Boolean).join("\n\n")} />
          </div>
          {turn.sources.length > 0 && (
            <details className="ai-sources">
              <summary>Passages used ({turn.sources.length})</summary>
              {turn.sources.map((passage, j) => (
                <blockquote key={j}>{passage}</blockquote>
              ))}
            </details>
          )}
        </div>
      ))}

      {pending && (
        <div className="ai-turn">
          <p className="ai-question">{pending.question}</p>
          <div className="ai-output" aria-live="polite">
            <AnswerBody text={pending.text} />
          </div>
          <div className="ai-actions">
            <button className="btn" onClick={() => answering.current?.abort()}>
              Stop
            </button>
          </div>
        </div>
      )}

      {error && <p className="hint">{error}</p>}

      {full ? (
        <div className="ai-actions">
          <p className="hint">This thread has used its room in the model's window, so there is no space for another passage.</p>
          <button className="btn btn-primary" onClick={startNew}>
            Start a new thread
          </button>
        </div>
      ) : (
        <form
          className="ai-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void send(question);
          }}
        >
          <input
            className="ai-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={thread.turns.length > 0 ? "Ask a follow-up" : "Ask a question about this item"}
            aria-label="Question"
            disabled={busy}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !question.trim()}>
            Ask
          </button>
        </form>
      )}

      {thread.turns.length > 0 && !busy && !full && (
        <div className="ai-actions">
          <button className="link" onClick={startNew}>
            Start a new thread
          </button>
          <span className="hint">Room left in this thread: about {Math.max(0, roomTokens(thread)).toLocaleString("en-GB")} tokens.</span>
        </div>
      )}

      <p className="hint">Written by {GEMMA.name} on this device. Check it against the original before you rely on it.</p>
    </>
  );
}
