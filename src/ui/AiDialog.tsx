import { useEffect, useRef, useState } from "react";
import { closeAi, QUICK_ACTIONS, QUICK_LABEL, useAiDialog, type AiTask, type QuickAction } from "../ai/dialog";
import { coverageLine, type Coverage } from "../ai/coverage";
import { download, generate, refresh, removeModel, stopDownload, unload, useAiStatus } from "../ai/engine";
import { GEMMA } from "../ai/model";
import { DEFINE_MAX_WORDS, EXPLAIN_LIMIT, quickPrompt, sourceCut, summarizePrompt, wordCount } from "../ai/prompts";
import { plainAnswer } from "../ai/format";
import "../ai/ai.css";
import { AnswerBody } from "../reader/markdown";
import { toast } from "../store/ui";
import { ConfirmDialog, Modal } from "./common";
import { AskThread } from "./AskThread";

/** Mounted once in the app; shows whichever AI dialog is open. */
export function AiDialog() {
  const task = useAiDialog((s) => s.task);
  if (!task) return null;
  return <AiModal key={task.mode + ("title" in task ? task.title : "")} task={task} />;
}

function AiModal({ task }: { task: AiTask }) {
  const status = useAiStatus();
  const [output, setOutput] = useState("");
  /** What the current summary or explanation was based on. Null when it used the whole text. */
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  /** The quick action that produced the current explanation, so its title and notes match it. */
  const [quick, setQuick] = useState<QuickAction>("explain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const answering = useRef<AbortController | null>(null);
  const loadingSeconds = useElapsed(status.phase === "loading");

  useEffect(() => {
    void refresh();
  }, []);

  const title =
    task.mode === "settings"
      ? "AI on this device"
      : task.mode === "summarize"
        ? "Summary"
        : task.mode === "explain"
          ? QUICK_LABEL[quick]
          : "Ask this item";
  const modelReady = status.phase === "ready" || status.phase === "loaded" || status.phase === "loading";
  const pct = status.progress ? Math.round((status.progress.received / status.progress.total) * 100) : 0;
  const summaryCut = task.mode === "summarize" ? sourceCut(task.text) : null;
  const note = coverage ? coverageLine(coverage) : null;

  const answer = async (prompt: string, cov: Coverage | null = null) => {
    setBusy(true);
    setError(null);
    setOutput("");
    setCoverage(cov);
    const ctl = new AbortController();
    answering.current = ctl;
    try {
      await generate(prompt, (text) => setOutput((o) => o + text), ctl.signal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      answering.current = null;
    }
  };

  const run = () => {
    if (task.mode === "summarize") {
      const cut = sourceCut(task.text);
      void answer(summarizePrompt(task.title, task.text), cut.cut ? { kind: "summary", used: cut.used, total: cut.total } : null);
    }
  };

  const runQuick = (action: QuickAction) => {
    if (task.mode !== "explain") return;
    setQuick(action);
    const cut = sourceCut(task.text, EXPLAIN_LIMIT);
    void answer(quickPrompt(action, task.text, task.title, task.context), cut.cut ? { kind: "explain", used: cut.used, total: cut.total } : null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([plainAnswer(output), note].filter(Boolean).join("\n\n"));
      toast("Copied.");
    } catch {
      toast("Couldn't copy. Select the text and copy it instead.");
    }
  };

  return (
    <>
      <Modal title={title} onClose={closeAi} wide top>
        <div className="ai-body">
          <Status phase={status.phase} pct={pct} message={status.message} loadingSeconds={loadingSeconds} />

          {status.phase === "absent" && (
            <>
              <ul className="ai-uses hint">
                <li>Summarize a long article in three bullet points.</li>
                <li>Explain a passage you highlighted, in plain words.</li>
                <li>Ask a question about one item, and see the passages the answer came from.</li>
              </ul>
              <div className="ai-actions">
                <button className="btn btn-primary" onClick={() => void download()}>
                  Download {GEMMA.name} (about 2 GB)
                </button>
              </div>
            </>
          )}
          {status.phase === "downloading" && (
            <div className="ai-actions">
              <button className="btn" onClick={stopDownload}>
                Stop download
              </button>
            </div>
          )}

          {task.mode === "settings" && modelReady && (
            <div className="ai-actions">
              {status.phase === "loaded" && (
                <button className="btn" onClick={unload}>
                  Free memory (keeps the download)
                </button>
              )}
              <button className="btn" onClick={() => setConfirming(true)}>
                Remove from this device
              </button>
            </div>
          )}

          {task.mode === "ask" && modelReady && <AskThread task={task} />}

          {task.mode !== "settings" && task.mode !== "ask" && modelReady && (
            <>
              {task.mode === "explain" ? (
                <div className="ai-actions">
                  {QUICK_ACTIONS.filter((a) => a !== "define" || wordCount(task.text) <= DEFINE_MAX_WORDS).map((a) => (
                    <button key={a} className={a === "explain" ? "btn btn-primary" : "btn"} onClick={() => runQuick(a)} disabled={busy}>
                      {QUICK_LABEL[a]}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="ai-actions">
                  <button className="btn btn-primary" onClick={run} disabled={busy}>
                    Summarize
                  </button>
                </div>
              )}
              {summaryCut?.cut && (
                <p className="hint">
                  This item is long. The summary covers its first {summaryCut.used.toLocaleString("en-GB")} of{" "}
                  {summaryCut.total.toLocaleString("en-GB")} characters.
                </p>
              )}
              {busy && (
                <div className="ai-actions">
                  <button className="btn" onClick={() => answering.current?.abort()}>
                    Stop
                  </button>
                </div>
              )}
            </>
          )}

          {error && <p className="hint">{error}</p>}
          {task.mode !== "ask" && output && (
            <>
              <div className="ai-output" aria-live="polite">
                <AnswerBody text={output} />
              </div>
              {quick === "counterpoint" && task.mode === "explain" && !busy && (
                <p className="hint">This is the critic's argument, not the author's.</p>
              )}
              {note && <p className="hint">{note}</p>}
              {!busy && (
                <>
                  <p className="hint">Written by {GEMMA.name} on this device. Check it against the original before you rely on it.</p>
                  <div className="ai-actions">
                    <button className="btn" onClick={() => void copy()}>
                      Copy
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          <p className="hint">Runs on this device. The text does not leave it.</p>
        </div>
      </Modal>
      {confirming && (
        <ConfirmDialog
          title="Remove the model?"
          action="Remove"
          danger
          onConfirm={() => removeModel()}
          onClose={() => setConfirming(false)}
        >
          <p>
            Your items and notes are not affected. To use these features again, you will need to download about 2 GB, which takes roughly
            9 minutes on a typical connection.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Seconds since `active` became true, so a long load shows that something is still happening. */
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

function Status({ phase, pct, message, loadingSeconds }: { phase: string; pct: number; message?: string; loadingSeconds: number }) {
  const text =
    phase === "checking"
      ? "Checking this device."
      : phase === "unsupported"
        ? "This device has no WebGPU, so the model cannot run here. Try a recent Chrome or Edge on a computer with a graphics card."
        : phase === "absent"
          ? `${GEMMA.name} is not on this device. Downloading it takes about 2 GB, roughly 9 minutes on a typical connection. The download comes from Hugging Face. Once it is here, nothing leaves this device. You can close this window and the download keeps going.`
          : phase === "downloading"
            ? `Downloading… ${pct}%. You can close this window; the download keeps going.`
            : phase === "ready"
              ? "Downloaded and kept on this device. The model loads the first time you use it."
              : phase === "loading"
                ? `Loading the model… ${loadingSeconds} s. You can keep using Engram while it loads.`
                : "Model loaded and ready.";
  return (
    <>
      <p className="ai-status">{text}</p>
      {message && <p className="hint">{message}</p>}
    </>
  );
}
