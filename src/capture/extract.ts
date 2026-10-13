/*
 * Turning a web page into an article you can read in Engram, on your device: Readability picks
 * the article out of the page, and a small walker writes it as Markdown (headings, paragraphs,
 * lists, quotes, code, tables, links and images). Only http(s) links and images survive; no
 * HTML is kept, so nothing from the page can run in the app.
 */

export interface Extracted {
  title?: string;
  markdown: string;
  /** Who wrote the article, from its byline. */
  author?: string;
  siteName?: string;
  /** The page's summary, or the opening text Readability picks when the page has none. */
  description?: string;
  /** When it was published, as ISO 8601. */
  published?: string;
}

/** The article in a page's HTML, or null if there's no readable article in it. */
export async function extractArticle(html: string, url: string): Promise<Extracted | null> {
  const { Readability } = await import("@mozilla/readability");
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Relative links and images resolve against the page's own address.
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);
  const article = new Readability(doc, { charThreshold: 300 }).parse();
  if (!article?.content) return null;
  const body = new DOMParser().parseFromString(`<base href="${encodeURI(url)}">${article.content}`, "text/html").body;
  const markdown = toMarkdown(body);
  if (markdown.replace(/\s/g, "").length < 200) return null;
  return {
    title: article.title?.trim() || undefined,
    markdown,
    // A byline is usually printed as "By Name"; the name is what's kept.
    author: metaText(article.byline?.replace(/^by\s+/i, "")),
    siteName: metaText(article.siteName),
    description: metaText(article.excerpt),
    published: isoDate(article.publishedTime),
  };
}

/**
 * The text encoding of a fetched page: the HTTP header's when it names one, else the page's own
 * <meta charset> (or http-equiv) in its first few kilobytes, else UTF-8. For /api/page, which decodes
 * the page before the app sees it.
 */
export function pageCharset(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  // The bytes are read as Latin-1, which never fails, just to find the ASCII tag.
  const start = new TextDecoder("latin1").decode(head.subarray(0, 4096));
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(start)?.[1];
  // A page can't truly be UTF-16 if its ASCII tag was readable, so browsers take that to mean UTF-8.
  return !meta || /^utf-16/i.test(meta) ? "utf-8" : meta.toLowerCase();
}

const MAX_META = 500;

/** A piece of page metadata on one line, capped; undefined when it's empty. */
export function metaText(value: string | null | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim().slice(0, MAX_META).trim() || undefined;
}

/** A date from a page as ISO 8601; undefined when it doesn't parse as one. */
export function isoDate(value: string | null | undefined): string | undefined {
  const t = Date.parse(value ?? "");
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Markdown for a block of HTML. */
export function toMarkdown(root: Element): string {
  return blocks(root, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "SVG", "CANVAS", "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "TEMPLATE"]);
const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|FIGURE|FIGCAPTION|HR|DL|DT|DD|DETAILS|SUMMARY)$/;

const isBlock = (n: Node) => n instanceof Element && BLOCK.test(n.tagName);

/** Block-level children, each separated by a blank line; `indent` prefixes every line (lists, quotes). */
function blocks(el: Element, indent: string): string {
  let out = "";
  let inline = "";
  const flush = () => {
    const t = withBreaks(inline);
    if (t) out += `${prefix(t, indent)}\n\n`;
    inline = "";
  };
  for (const n of Array.from(el.childNodes)) {
    if (isBlock(n)) {
      flush();
      out += block(n as Element, indent);
    } else if (n instanceof Element && !SKIP.has(n.tagName) && hasBlock(n)) {
      // Older hand-made sites wrap a whole essay in <font> or <span>; its paragraphs stay paragraphs.
      flush();
      out += blocks(n, indent);
    } else inline += inlineOf(n);
  }
  flush();
  return out;
}

/** Whether an inline element holds a block (a paragraph, a list…) somewhere inside it. */
function hasBlock(el: Element): boolean {
  return Array.from(el.childNodes).some((c) => isBlock(c) || (c instanceof Element && !SKIP.has(c.tagName) && hasBlock(c)));
}

const prefix = (text: string, indent: string) => text.split("\n").map((l) => (l ? indent + l : indent.trimEnd())).join("\n");

function block(el: Element, indent: string): string {
  const tag = el.tagName;
  if (SKIP.has(tag)) return "";
  const m = /^H([1-6])$/.exec(tag);
  if (m) {
    const t = inlineText(el);
    return t ? `${indent}${"#".repeat(Number(m[1]))} ${t}\n\n` : "";
  }
  switch (tag) {
    case "P": {
      const t = withBreaks(Array.from(el.childNodes).map(inlineOf).join(""));
      return t ? `${prefix(t, indent)}\n\n` : "";
    }
    case "DT":
    case "SUMMARY":
    case "FIGCAPTION": {
      const t = inlineText(el);
      if (!t) return "";
      return `${prefix(tag === "FIGCAPTION" ? `*${t}*` : tag === "DT" ? `**${t}**` : t, indent)}\n\n`;
    }
    case "HR":
      return `${indent}---\n\n`;
    case "PRE": {
      const code = (el.textContent ?? "").replace(/\n+$/, "");
      if (!code.trim()) return "";
      const fence = code.includes("```") ? "~~~" : "```";
      return `${prefix(`${fence}\n${code}\n${fence}`, indent)}\n\n`;
    }
    case "BLOCKQUOTE":
      return blocks(el, `${indent}> `).replace(/(> \n)+$/, "") + `${indent.trimEnd()}\n`;
    case "UL":
    case "OL": {
      let out = "";
      let i = Number(el.getAttribute("start")) || 1;
      for (const li of Array.from(el.children)) {
        if (li.tagName !== "LI") continue;
        const mark = tag === "OL" ? `${i++}. ` : "- ";
        const pad = indent + " ".repeat(mark.length);
        const inner = blocks(li, pad).replace(/\n{2,}/g, "\n").trimEnd();
        if (inner.trim()) out += `${indent}${mark}${inner.startsWith(pad) ? inner.slice(pad.length) : inner.trimStart()}\n`;
      }
      return out ? `${out}\n` : "";
    }
    case "TABLE":
      return table(el, indent);
    default:
      return blocks(el, indent);
  }
}

function table(el: Element, indent: string): string {
  const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === "TD" || c.tagName === "TH")
      .map((c) => inlineText(c).replace(/\|/g, "\\|") || " "),
  );
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!width) return "";
  const line = (r: string[]) => `${indent}| ${[...r, ...Array(width - r.length).fill(" ")].join(" | ")} |`;
  return [line(rows[0]), `${indent}|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n") + "\n\n";
}

/** A paragraph that starts like a list item or a rule ("1. ", "- ") stays a paragraph. */
const plainStart = (t: string) => t.replace(/^(\d+)([.)] )/, "$1\\$2").replace(/^([-+] |-{3,}$|={3,}$)/, "\\$1");

/** Stands for a <br> until the text around it is tidied. A private-use character, so no page text is mistaken for it. */
const BR = "\uE000";

/** Text on one line, for headings, captions and table cells: a <br> is a space there. */
const inlineText = (el: Element) => Array.from(el.childNodes).map(inlineOf).join("").replaceAll(BR, " ").replace(/\s+/g, " ").trim();

/**
 * A paragraph's text: spaces tidied, one <br> kept as a line break, and two or more in a row as a paragraph
 * break (old sites write paragraphs as <br><br>). A line that starts like a list or a rule stays plain text.
 */
export function withBreaks(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[ \uE000]+|[ \uE000]+$/g, "")
    .replace(/ ?\uE000(?: ?\uE000)+ ?/g, "\n\n")
    .replace(/ ?\uE000 ?/g, "\\\n")
    .split("\n")
    .map(plainStart)
    .join("\n");
}

/** Markdown's own characters in page text are escaped, and "<" always is, so no comment marker or HTML can form. */
const escape = (t: string) => t.replaceAll(BR, "").replace(/[\\`*_[\]<>#|~]/g, "\\$&");

const httpUrl = (u: string | null) => {
  if (!u) return null;
  try {
    const url = new URL(u, document.baseURI);
    return /^https?:$/.test(url.protocol) ? url.href.replace(/[()]/g, (c) => encodeURIComponent(c)) : null;
  } catch {
    return null;
  }
};

function inlineOf(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return escape(n.textContent ?? "");
  if (!(n instanceof Element) || SKIP.has(n.tagName)) return "";
  const inner = () => Array.from(n.childNodes).map(inlineOf).join("");
  switch (n.tagName) {
    case "BR":
      return BR;
    case "STRONG":
    case "B": {
      const t = inner().trim();
      return t ? `**${t}**` : "";
    }
    case "EM":
    case "I": {
      const t = inner().trim();
      return t ? `*${t}*` : "";
    }
    case "DEL":
    case "S":
      return `~~${inner()}~~`;
    case "CODE": {
      const t = (n.textContent ?? "").replace(/\s+/g, " ");
      const tick = t.includes("`") ? "``" : "`";
      return t.trim() ? `${tick}${t}${tick}` : "";
    }
    case "A": {
      const t = inner().trim();
      const href = httpUrl((n as HTMLAnchorElement).getAttribute("href") && (n as HTMLAnchorElement).href);
      return href && t ? `[${t}](${href})` : t;
    }
    case "IMG": {
      const img = n as HTMLImageElement;
      const src = httpUrl(img.getAttribute("src") && img.src);
      return src ? `![${escape(img.alt ?? "").replace(/\s+/g, " ").trim()}](${src})` : "";
    }
    default:
      return inner();
  }
}

// ---------------------------------------------------------------------------------------------
// Small rules for saving pages. They need no storage, so they live here, where tests can reach them.

/** Ends a page's text when it was too long to keep whole, so a reader knows the rest is missing. */
export const CUT_NOTE = "Engram kept only the first part of this page: it was too long to save whole. The rest is at the source.";

/**
 * Text capped at `max` characters, cut at a paragraph break where there is one, so a cap never leaves half a
 * code fence or table row. A cut is marked at the end (in italics for Markdown).
 */
export function capText(text: string, max: number, markdown: boolean): string {
  if (text.length <= max) return text;
  const para = text.lastIndexOf("\n\n", max);
  const kept = text.slice(0, para > max / 2 ? para : max).trimEnd();
  return `${kept}\n\n${markdown ? `*${CUT_NOTE}*` : `[${CUT_NOTE}]`}`;
}

/** How much there is to read in a text: its characters, without spaces or Markdown's marks. */
export const readingLength = (text: string | undefined) => text?.replace(/[\s*_#>`[\]()\-]/g, "").length ?? 0;

/**
 * Whether a newer copy of a page is much shorter than the one saved. A page behind a login or a paywall comes
 * back like that, and then the fuller copy is kept.
 */
export const shrinks = (next: string, saved: string | undefined) => readingLength(next) < readingLength(saved) * 0.6;

/** The PDF behind a link: a link straight to a .pdf, or an arXiv paper's page or PDF. Null for anything else. */
export function pdfUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (/^(www\.|export\.)?arxiv\.org$/i.test(u.hostname)) {
    const id = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i.exec(u.pathname)?.[1];
    if (id) return `https://arxiv.org/pdf/${id}`;
  }
  return /\.pdf$/i.test(u.pathname) ? u.href : null;
}
