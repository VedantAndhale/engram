/*
 * The geometry of the article minimap: a thin strip that stands for the whole text. Everything is in
 * pixels down the page; the strip is `rail` pixels tall. No DOM, so it is tested directly.
 */

export interface Span {
  top: number;
  height: number;
}

/** The shortest a bar is drawn, so a one-line paragraph can still be seen and aimed at. */
export const MIN_BAR = 2;

/** `spans` of a text `total` pixels tall, drawn on a strip `rail` pixels tall. */
export function scaleSpans(spans: Span[], total: number, rail: number): Span[] {
  if (total <= 0 || rail <= 0) return [];
  const k = rail / total;
  return spans.map((s) => {
    const height = Math.max(MIN_BAR, s.height * k - 1);
    // A bar that would run off the bottom is pulled back in.
    return { top: Math.min(Math.max(0, s.top * k), Math.max(0, rail - height)), height };
  });
}

/** The strip's picture of what is on screen: `scrollTop` is how far the text has been read past its top. */
export function viewWindow(scrollTop: number, view: number, total: number, rail: number): Span {
  if (total <= 0) return { top: 0, height: rail };
  const k = rail / total;
  const height = Math.max(MIN_BAR, Math.min(view * k, rail));
  // Pulled back in at the end, so even scrolling past it keeps the window on the strip.
  return { top: Math.min(Math.max(0, scrollTop * k), Math.max(0, rail - height)), height };
}

/**
 * Where to scroll so the point `y` on the strip is in the middle of the screen: how far down the text
 * to put the top of the view. Never before the start or past the end.
 */
export function viewTopFor(y: number, rail: number, total: number, view: number): number {
  if (rail <= 0 || total <= view) return 0;
  const at = (Math.min(Math.max(0, y), rail) / rail) * total;
  return Math.min(Math.max(0, at - view / 2), total - view);
}
