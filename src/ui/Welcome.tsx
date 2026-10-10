import { ArrowRight, LoaderCircle, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { visibleFolders } from "../folders/registry";
import { setHabit, SUGGESTED_TOPICS, useHabit } from "../habit/prefs";
import { addPdf, setItemTopics } from "../store/actions";
import { lastFolder, navigate, toast } from "../store/ui";
import { ReminderSetup, TopicPicker } from "./habit";

type Step = "hello" | "topics" | "reminder" | "first";

/** First run: why Engram exists, what you want to grow in, a daily cue, and the first thing to read. */
export function Welcome() {
  const [step, setStep] = useState<Step>("hello");
  const topics = useHabit((s) => s.topics);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const finish = (to?: { folder: string; doc: string }) => {
    setHabit({ welcomed: true });
    navigate(to ? { name: "reader", folder: to.folder, doc: to.doc } : { name: "today" });
  };

  const addFirst = async (file: File) => {
    setBusy(true);
    try {
      const folders = await visibleFolders();
      const folder = folders.find((f) => f.id === lastFolder()) ?? folders[0];
      const hash = await addPdf(folder.id, file);
      // With one topic chosen, the first document clearly belongs to it.
      if (topics.length === 1) await setItemTopics(folder.id, hash, topics);
      finish({ folder: folder.id, doc: hash });
    } catch (e) {
      console.error(e);
      toast(`Couldn't read ${file.name}. Is it a valid PDF?`);
      setBusy(false);
    }
  };

  const steps: Step[] = ["hello", "topics", "reminder", "first"];

  return (
    <main className="welcome">
      <div className="welcome-card">
        <ol className="welcome-steps" aria-label="Progress">
          {steps.map((s) => (
            <li key={s} className={s === step ? "on" : steps.indexOf(s) < steps.indexOf(step) ? "done" : ""} />
          ))}
        </ol>

        {step === "hello" && (
          <>
            <img src="./icon.svg" alt="" width={44} height={44} />
            <h1>Welcome to Engram</h1>
            <p className="lead">Any fact is a chat away now. What you notice, understand and connect is still yours to build.</p>
            <p className="muted">
              Engram is a place to keep it: read, highlight what matters, say why in your own words, and see it again before it fades. A
              few minutes a day is enough.
            </p>
            <div className="welcome-actions">
              <button className="btn btn-primary" autoFocus onClick={() => setStep("topics")}>
                Get started <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === "topics" && (
          <>
            <h1>What do you want to grow in?</h1>
            <p className="muted">Pick a few. You can change them any time.</p>
            <TopicPicker options={SUGGESTED_TOPICS} value={topics} onChange={(t) => setHabit({ topics: t })} />
            <div className="welcome-actions">
              <button className="btn" onClick={() => setStep("reminder")}>
                Skip
              </button>
              <button className="btn btn-primary" disabled={!topics.length} onClick={() => setStep("reminder")}>
                Continue <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === "reminder" && (
          <>
            <h1>When should we nudge you?</h1>
            <p className="muted">Habits stick when they have a cue. Choose a time you're usually free for five minutes.</p>
            <ReminderSetup onDone={() => setStep("first")} />
            <div className="welcome-actions">
              <button className="btn" onClick={() => setStep("first")}>
                Not now
              </button>
            </div>
          </>
        )}

        {step === "first" && (
          <>
            <h1>Start with one thing</h1>
            <p className="muted">
              Add a PDF you've been meaning to read: a paper, a chapter, an essay. When a sentence matters, highlight it and write one line
              about why.
            </p>
            <div className="welcome-actions">
              <button className="btn" disabled={busy} onClick={() => finish()}>
                I'll do it later
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />} Add a PDF
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void addFirst(f);
              }}
            />
            <p className="hint">Everything stays on this device. You can back it up to your own GitHub later.</p>
          </>
        )}
      </div>
    </main>
  );
}
