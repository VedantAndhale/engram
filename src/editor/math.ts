import { WidgetType } from "@codemirror/view";

/*
 * $inline$ and $$display$$ math, drawn by KaTeX. KaTeX (and its fonts) only load the first time
 * a note has math in it.
 */

let katex: Promise<typeof import("katex").default> | null = null;
const load = () =>
  (katex ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => k.default));

/** $x^2$: a dollar sign that isn't escaped, then no space after it and none before the closing one. */
export const INLINE_MATH = /(?<![\\$\w])\$(?=[^\s$])((?:\\\$|[^$\n])*?[^\s\\$])\$(?![\w$])/g;

/**
 * A block widget's outer box. Its spacing is padding, never margin: CodeMirror measures block
 * heights without margins, so a margin would shift everything below it (and the grips beside it).
 */
export function blockBox(inner: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-block-widget";
  box.appendChild(inner);
  return box;
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  get estimatedHeight() {
    return this.display ? 48 : -1;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math cm-math-display" : "cm-math";
    el.textContent = this.tex;
    void load().then((k) => {
      try {
        k.render(this.tex, el, { displayMode: this.display, throwOnError: true, output: "htmlAndMathml" });
      } catch {
        el.classList.add("is-error");
        el.title = "This math doesn't parse";
        el.textContent = this.tex;
      }
    });
    return this.display ? blockBox(el) : el;
  }
  ignoreEvent() {
    return false;
  }
}
