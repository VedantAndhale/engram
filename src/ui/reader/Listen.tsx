import { Pause, Play, SkipForward, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { scrollMotion } from "../../lib/util";
import { Speaker, type Para, type SpeakerState } from "../../reader/speech";
import "../../styles/notes.css";
import { stickyReach } from "./ArticleView";
import { readingPara } from "./AskBar";

/** The paragraph being read is marked like a cited one, with a bar beside it. */
const READING = "para-reading";

/**
 * Read the article aloud with the browser's own voices, from the paragraph in view. The paragraph being
 * read is marked and kept on screen. Nothing is sent anywhere. Where the browser has no speech engine, this
 * draws nothing at all.
 */
export function Listen({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [state, setState] = useState<SpeakerState>("idle");
  const speaker = useRef<Speaker | null>(null);
  const marked = useRef<HTMLElement | null>(null);

  const mark = (n: number | null) => {
    marked.current?.classList.remove(READING);
    marked.current = null;
    const root = scroller.current;
    const el = n === null ? null : root?.querySelector<HTMLElement>(`.article-text [data-para="${n}"]`);
    if (!el || !root) return;
    el.classList.add(READING);
    marked.current = el;
    // Keep it in view: if it is under the bars or below the fold, bring it up below them.
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const reach = stickyReach(root);
    if (top < reach + 8 || top > root.clientHeight - 120) root.scrollTo({ top: root.scrollTop + top - reach - 24, behavior: scrollMotion() });
  };

  const stop = () => speaker.current?.stop();

  const play = () => {
    const root = scroller.current;
    if (!root || typeof speechSynthesis === "undefined") return;
    const paras: Para[] = [...root.querySelectorAll<HTMLElement>(".article-text [data-para]")].map((el) => ({ n: Number(el.dataset.para), text: el.textContent ?? "" }));
    const from = Math.max(0, paras.findIndex((p) => p.n >= readingPara(root)));
    speaker.current?.stop();
    speaker.current = new Speaker(
      // Every clip it speaks was made below, as a SpeechSynthesisUtterance.
      {
        speak: (clip) => speechSynthesis.speak(clip as SpeechSynthesisUtterance),
        cancel: () => speechSynthesis.cancel(),
        pause: () => speechSynthesis.pause(),
        resume: () => speechSynthesis.resume(),
      },
      paras,
      (text) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = navigator.language;
        return u;
      },
      { onPara: mark, onChange: setState },
    );
    speaker.current.start(from);
  };

  // Leaving the page, or pressing Escape, silences it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && speaker.current?.state !== undefined && speaker.current.state !== "idle") speaker.current.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      speaker.current?.stop();
    };
  }, []);

  if (typeof speechSynthesis === "undefined") return null;

  if (state === "idle")
    return (
      <button className="icon-btn" aria-label="Read aloud" title="Read aloud from here" onClick={play}>
        <Volume2 size={17} />
      </button>
    );

  return (
    <span className="listen-controls" role="group" aria-label="Reading aloud">
      <button className="icon-btn on" aria-label={state === "paused" ? "Resume" : "Pause"} title={state === "paused" ? "Resume" : "Pause"} onClick={() => (state === "paused" ? speaker.current?.resume() : speaker.current?.pause())}>
        {state === "paused" ? <Play size={17} /> : <Pause size={17} />}
      </button>
      <button className="icon-btn" aria-label="Next paragraph" title="Next paragraph" onClick={() => speaker.current?.next()}>
        <SkipForward size={17} />
      </button>
      <button className="icon-btn" aria-label="Stop reading" title="Stop (Esc)" onClick={stop}>
        <Square size={15} />
      </button>
    </span>
  );
}
