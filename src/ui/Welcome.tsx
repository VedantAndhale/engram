import { ArrowRight, Link as LinkIcon, LoaderCircle, Pause, Play, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { findUrl, saveLink } from "../capture/capture";
import { createFolder, visibleFolders } from "../folders/registry";
import { setHabit, SUGGESTED_TOPICS, useHabit } from "../habit/prefs";
import { addPdf, setItemTopics } from "../store/actions";
import { lastFolder, navigate, toast } from "../store/ui";
import { startSignIn } from "../sync/signin";
import { ReminderSetup, TopicPicker } from "./habit";
import { GitHubMark } from "./common";

type Step = "hello" | "topics" | "reminder" | "first";

/** First run: why Engram exists, what you want to grow in, a daily cue, and the first thing to read. */
export function Welcome() {
  const [step, setStep] = useState<Step>("hello");
  const topics = useHabit((s) => s.topics);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // A new step starts at its heading, so a screen reader reads it and Tab goes on from there.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const finish = (to?: { folder: string; doc: string; pdf: boolean }) => {
    setHabit({ welcomed: true });
    if (!to) return navigate({ name: "today" });
    navigate(to.pdf ? { name: "reader", folder: to.folder, doc: to.doc } : { name: "item", folder: to.folder, item: to.doc });
  };

  // The reader is saving something here, so if there is no folder left, make one for it.
  const intoFolder = async () => {
    const folders = await visibleFolders();
    return folders.find((f) => f.id === lastFolder()) ?? folders[0] ?? (await createFolder("My library"));
  };

  const addFirst = async (file: File) => {
    setBusy(true);
    try {
      const folder = await intoFolder();
      const hash = await addPdf(folder.id, file);
      // With one topic chosen, the first document clearly belongs to it.
      if (topics.length === 1) await setItemTopics(folder.id, hash, topics);
      finish({ folder: folder.id, doc: hash, pdf: true });
    } catch (e) {
      console.error(e);
      toast(`Couldn't read ${file.name}. Is it a valid PDF?`);
      setBusy(false);
    }
  };

  // A share or a copy often brings words around the link; the link is what's saved.
  const url = findUrl(link);
  const saveFirst = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url || busy) return;
    setBusy(true);
    try {
      const folder = await intoFolder();
      const { item } = await saveLink(folder.id, { url, topics: topics.length === 1 ? topics : undefined });
      finish({ folder: folder.id, doc: item.id, pdf: item.type === "pdf" });
    } catch (err) {
      console.error(err);
      toast("Couldn't save that link. Check it and try again.");
      setBusy(false);
    }
  };

  const steps: Step[] = ["hello", "topics", "reminder", "first"];

  return (
    <main className="welcome">
      <div className="welcome-card">
        <ol className="welcome-steps" aria-hidden="true">
          {steps.map((s) => (
            <li key={s} className={s === step ? "on" : steps.indexOf(s) < steps.indexOf(step) ? "done" : ""} />
          ))}
        </ol>
        <p className="visually-hidden">
          Step {steps.indexOf(step) + 1} of {steps.length}
        </p>

        {step === "hello" && (
          <>
            <img src="./icon.svg" alt="" width={44} height={44} />
            <h1 ref={heading} tabIndex={-1}>
              Read it, highlight it, keep what matters.
            </h1>
            <p className="lead">Read articles and PDFs, highlight what matters, and keep notes as Markdown.</p>
            <DemoGif />
            <ul className="welcome-points">
              <li>
                <strong>No account to start.</strong> Reading, saving and search work without one. Sign in with GitHub for sync and agents.
                It asks for access to your private repositories, and Engram's server records your primary email.
              </li>
              <li>
                <strong>Plain files, when you sync.</strong> With sync on, each folder is a GitHub repository in your account, created
                private, holding your notes as Markdown.
              </li>
              <li>
                <strong>Highlights come back.</strong> Today brings them back on a spacing schedule, starting a day after you save them.
              </li>
            </ul>
            <div className="welcome-actions">
              <button className="btn" disabled={!navigator.onLine} onClick={startSignIn} title="Your folders come down from GitHub">
                <GitHubMark size={14} /> I already use Engram: sign in
              </button>
              <button className="btn btn-primary" autoFocus onClick={() => setStep("topics")}>
                Start reading <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === "topics" && (
          <>
            <h1 ref={heading} tabIndex={-1}>
              What do you want to grow in?
            </h1>
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
            <h1 ref={heading} tabIndex={-1}>
              When should we nudge you?
            </h1>
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
            <h1 ref={heading} tabIndex={-1}>
              Start with one thing
            </h1>
            <p className="muted">
              Paste a link to something you've been meaning to read: an article, an essay, a paper. When a sentence matters, highlight it
              and write one line about why.
            </p>
            <form className="welcome-link" onSubmit={saveFirst}>
              <label className="visually-hidden" htmlFor="welcome-link">
                Link to save
              </label>
              <input
                id="welcome-link"
                type="text"
                inputMode="url"
                autoComplete="off"
                placeholder="Paste a link"
                value={link}
                disabled={busy}
                onChange={(e) => setLink(e.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={!url || busy}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <LinkIcon size={16} />} Save link
              </button>
            </form>
            <div className="welcome-actions">
              <button className="btn" disabled={busy} onClick={() => finish()}>
                I'll do it later
              </button>
              <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Upload size={16} /> Add a PDF instead
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
            <p className="hint">Everything stays in this browser until you connect GitHub, which keeps a private copy and syncs your devices.</p>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * The demo, with a pause button. With reduced motion asked for, it starts paused on its first
 * frame. Pausing draws the frame on screen into a canvas, since a GIF itself can't be paused.
 */
function DemoGif() {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const [playing, setPlaying] = useState(!reduce);
  const img = useRef<HTMLImageElement>(null);
  const still = useRef<HTMLCanvasElement>(null);
  const draw = () => {
    const i = img.current;
    const c = still.current;
    if (!i || !c || !i.complete || !i.naturalWidth) return;
    c.width = i.naturalWidth;
    c.height = i.naturalHeight;
    c.getContext("2d")?.drawImage(i, 0, 0);
  };
  // Starting paused: the still is drawn once the picture has loaded.
  useEffect(() => {
    if (!reduce) return;
    const i = img.current;
    if (i?.complete) draw();
    else i?.addEventListener("load", draw, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const alt = "Demo: save a quote, highlight a passage with a note, then review it on Today and space it out.";
  return (
    <figure className="welcome-demo-wrap">
      <img ref={img} className="welcome-demo" src="./engram-demo.gif" alt={alt} width={960} height={640} hidden={!playing} />
      <canvas ref={still} className="welcome-demo" width={960} height={640} hidden={playing} role="img" aria-label={alt} />
      <button
        className="btn btn-small demo-toggle"
        aria-pressed={!playing}
        onClick={() => {
          if (playing) draw();
          setPlaying(!playing);
        }}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? "Pause demo" : "Play demo"}
      </button>
    </figure>
  );
}
