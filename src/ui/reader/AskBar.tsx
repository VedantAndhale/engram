import "../../styles/notes.css";
import { ArrowUp } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { STARTER_QUESTIONS } from "../../ai/dialog";
import { addNote } from "../../ai/notes";

/**
 * The paragraph the reader is on: the first one whose bottom is below the sticky bars, so a note about the
 * whole article lands beside what they were reading and stays where their head was.
 */
export function readingPara(scroller: HTMLElement | null): number {
  if (!scroller) return 1;
  const line = scroller.getBoundingClientRect().top + 120;
  let last = 1;
  for (const el of scroller.querySelectorAll<HTMLElement>(".article-text [data-para]")) {
    last = Number(el.dataset.para);
    if (el.getBoundingClientRect().bottom > line) return last;
  }
  return last;
}

/** A summary of the whole article, as a note beside the paragraph in view. */
export function summarizeHere(item: string, scroller: HTMLElement | null): void {
  addNote({ item, action: "summary", para: readingPara(scroller) });
}

/**
 * Ask about the whole article. Select a passage to ask about just that. The answer is a note beside the
 * paragraph in view. Starter questions show while the box is focused and empty, so it is never blank.
 */
export function AskBar({ item, scroller }: { item: string; scroller: RefObject<HTMLElement | null> }) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);

  const ask = (question: string) => {
    const text = question.trim();
    if (!text) return;
    addNote({ item, action: "ask", para: readingPara(scroller.current), question: text });
    setQ("");
    input.current?.blur();
  };

  return (
    <div className="askbar">
      {focused && !q && (
        <div className="askbar-chips">
          <button type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => summarizeHere(item, scroller.current)}>
            Summarize
          </button>
          {STARTER_QUESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="askbar-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              input.current?.blur();
            }
          }}
          placeholder="Ask about this article, or select a passage"
          aria-label="Ask about this article"
        />
        <button className="icon-btn" type="submit" aria-label="Ask" title="Ask" disabled={!q.trim()}>
          <ArrowUp size={17} />
        </button>
      </form>
    </div>
  );
}
