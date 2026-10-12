/*
 * "Save to Engram": a bookmark whose address is a small script. Clicking it on any page opens
 * Engram's save window and hands it the page through postMessage, so nothing travels in a URL
 * or through a server. Nothing to publish in any store, and it works in every desktop browser.
 */

/** A message from the bookmarklet to the save window. */
export interface CaptureMessage {
  type: "engram-capture";
  url: string;
  title: string;
  text: string;
  /** The whole page, so Engram can keep the article's formatting. Empty from older bookmarklets. */
  html: string;
  selection: string;
  /** What the page's meta tags say about itself. Empty when the page has none, or from older bookmarklets. */
  author: string;
  siteName: string;
  description: string;
  published: string;
}

export const READY = "engram-ready";

/**
 * Runs on the page being saved, not in Engram, so it must not use anything outside itself.
 * The save window says when it is ready; only then, and only to Engram's origin, is the page sent.
 */
function capture(app: string) {
  const origin = new URL(app).origin;
  const w = window.open(`${app}#/save`, "engram-save", "width=520,height=720");
  if (!w) {
    alert("Allow pop-ups on this site to save it to Engram.");
    return;
  }
  const og = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
  const root = (document.querySelector("article") || document.querySelector("main, [role=main]") || document.body) as HTMLElement;
  // The first of these tags that has a value. A profile link (article:author is often one) is not a name, so links are skipped.
  const meta = (...selectors: string[]) => {
    for (const s of selectors) {
      const v = ((document.querySelector(s) as HTMLMetaElement | null)?.content || "").trim();
      if (v && !/^https?:/i.test(v)) return v;
    }
    return "";
  };
  const data = {
    type: "engram-capture",
    url: location.href,
    title: (og && og.content) || document.title,
    text: (root.innerText || "").slice(0, 200000),
    html: document.documentElement.outerHTML.slice(0, 3000000),
    selection: String(getSelection() || "").slice(0, 20000),
    author: meta('meta[name="author"]', 'meta[property="article:author"]'),
    siteName: meta('meta[property="og:site_name"]'),
    description: meta('meta[name="description"]', 'meta[property="og:description"]'),
    published: meta('meta[property="article:published_time"]'),
  };
  const onMessage = (e: MessageEvent) => {
    if (e.source !== w || e.origin !== origin || e.data !== "engram-ready") return;
    w.postMessage(data, origin);
    removeEventListener("message", onMessage);
  };
  addEventListener("message", onMessage);
}

/** The bookmark's address for this copy of Engram. */
export function bookmarkletHref(app = location.origin + location.pathname): string {
  return `javascript:${encodeURIComponent(`(${capture.toString()})(${JSON.stringify(app)});void 0`)}`;
}

/** Check a message really is a capture, with the fields the save window needs. */
export function asCapture(data: unknown): CaptureMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "engram-capture" || typeof d.url !== "string" || !/^https?:\/\//i.test(d.url)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    type: "engram-capture",
    url: d.url,
    title: str(d.title),
    text: str(d.text),
    html: str(d.html),
    selection: str(d.selection),
    author: str(d.author),
    siteName: str(d.siteName),
    description: str(d.description),
    published: str(d.published),
  };
}
