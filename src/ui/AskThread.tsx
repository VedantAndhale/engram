import { useMemo, useRef, useState } from "react";
import { articlePassages, chunkText, pickPassages } from "../ai/chunks";
import { coverageLine, labelsIn, type Coverage } from "../ai/coverage";
import { closeAi, type AskTask } from "../ai/dialog";
import { dropThread, generate } from "../ai/engine";
import { GEMMA } from "../ai/model";
import { plainAnswer } from "../ai/format";
import { askPrompt, followUpPrompt } from "../ai/prompts";
import { addTurn, clearThread, markRebuild, passageBudget, roomTokens, skippable, syncText, threadOf, useThreads, type Turn } from "../ai/thread";
import { paragraphsOf, type CiteKind } from "../reader/paragraphs";
import { AnswerBody, type Cite } from "../reader/markdown";
import { navigate, toast, jumpToParagraph } from "../store/ui";

/** Starting points for an empty thread, so an empty box is not a blank page. Each one asks at once. */
const QUESTIONS = ["What is the main point?", "What examples does it give?", "Which people, places or dates come up?"];

/** A short fingerprint of the item's text, so a change since an answer can be told. */
function fingerprint(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

/** The Ask dialog's conversation: the item's questions and answers, with a box for the next one. */
export function AskThread({ task }: { task: AskTask }) {
  const thread = useThreads((s) => s.threads[task.key]) ?? threadOf(task.key);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<{ question: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answering = useRef<AbortController | null>(null);

  const src = task.source;
  /** What a citation names: a PDF's page, or an article's paragraph. Null when the item has neither. */
  const cite: CiteKind | null = src ? "page" : task.article ? "para" : null;
  const textKey = useMemo(() => fingerprint(task.text), [task.text]);
  const paragraphs = useMemo(() => (task.article ? paragraphsOf(task.text, task.article.markdown) : []), [task.text, task.article]);
  const chunks = useMemo(() => (task.article ? articlePassages(paragraphs) : chunkText(task.text)), [task.text, task.article, paragraphs]);
  const paragraphText = useMemo(() => new Map(paragraphs.map((p) => [p.n, p.text])), [paragraphs]);
  const full = thread.turns.length > 0 && passageBudget(thread) === 0;

  const send = async (q: string) => {
    const asked = q.trim();
    if (!asked || busy) return;
    // The item may have been saved again since the thread began: its passages then need sending again.
    syncText(task.key, textKey);
    const cur = threadOf(task.key);
    const limit = passageBudget(cur);
    if (limit === 0) {
      setError("This thread has used its room. Start a new thread to keep asking.");
      return;
    }
    const picked = pickPassages(asked, chunks, limit, task.text.trim().length, skippable(cur));
    const partial = picked.sent < picked.passages;
    const prompt =
      cur.turns.length === 0
        ? askPrompt(asked, picked.texts, task.title, partial, cite)
        : followUpPrompt(asked, picked.texts, task.title, partial, cite);
    const labels = labelsIn(picked.texts, cite ?? "page");
    const coverage: Coverage = { kind: "ask", picked, pages: labels };
    const rebuilt = cur.needsRebuild;
    setBusy(true);
    setError(null);
    setQuestion("");
    setPending({ question: asked, text: "" });
    const ctl = new AbortController();
    answering.current = ctl;
    try {
      const out = await generate(
        prompt,
        (piece) => setPending((p) => (p ? { ...p, text: p.text + piece } : p)),
        ctl.signal,
        { key: task.key, turns: cur.turns.map((t) => ({ question: t.question, answer: t.answer })), rebuild: cur.needsRebuild },
      );
      if (out.cancelled && out.text.trim() === "") {
        // Stopped before any words came: nothing to keep, but the conversation is gone and must be rebuilt.
        markRebuild(task.key);
        setError("Stopped before the answer started. Ask again to continue.");
      } else {
        const turn: Turn = {
          question: asked,
          answer: out.text,
          note: coverageLine(coverage),
          sources: picked.texts,
          pages: labels,
          stopped: out.cancelled,
          textKey,
          quotes: Object.fromEntries(cite === "para" ? labels.map((n) => [n, paragraphText.get(n) ?? ""]) : []),
        };
        addTurn(task.key, turn, out.tokens, picked.indexes, out.threadEnded, rebuilt);
      }
    } catch (err) {
      markRebuild(task.key);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      setBusy(false);
      answering.current = null;
    }
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

  const copy = async (turn: Turn) => {
    try {
      await navigator.clipboard.writeText([plainAnswer(turn.answer), turn.note].filter(Boolean).join("\n\n"));
      toast("Copied.");
    } catch {
      toast("Couldn't copy. Select the text and copy it instead.");
    }
  };

  return (
    <>
      {thread.turns.length === 0 && !pending && (
        <div className="ai-chips">
          {QUESTIONS.map((q) => (
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
            <button className="btn" onClick={() => void copy(turn)}>
              Copy
            </button>
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
