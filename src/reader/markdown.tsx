import { GFM, parser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { externalUrl } from "../lib/util";
import { MARKS, topBlocks, type CiteKind } from "./paragraphs";

/*
 * A saved article, drawn for reading. The Markdown is parsed with the parser the editor already
 * ships and turned straight into React elements. The text is someone else's, so nothing in it
 * becomes HTML: tags in the text are dropped, and only http(s) links and images are kept.
 * Older saves are plain text: one paragraph per line.
 *
 * Answers from the on-device model (AnswerBody) use the same parser with three limits: no images
 * and no outside links, because a page could steer the model into putting your question in an
 * image address; and headings drawn small, because the dialog already has a title.
 */

const md = parser.configure(GFM);

/** How a block is drawn. Articles keep their links and images; model answers do not. */
interface Opts {
  ai: boolean;
  /** Set for an answer about a PDF: page citations become buttons, and only the pages in `pages` get one. */
  cite?: Cite;
}
export interface Cite {
  /** "page" for a PDF's answer ([Page 3]), "para" for an article's ([¶3]). */
  kind: CiteKind;
  /** The numbers that were sent to the model. A citation of any other number stays plain text. */
  numbers: Set<number>;
  /** Opens the page or paragraph a citation names. */
  onOpen: (n: number) => void;
}
const ARTICLE: Opts = { ai: false };

const safeUrl = externalUrl;

const HEADING = /^(?:ATX|Setext)Heading(\d)$/;
/** The blocks that can hold a heading. Headings never sit inside a table, code or a paragraph. */
const CONTAINERS = new Set(["Blockquote", "BulletList", "OrderedList", "ListItem"]);

export interface ArticleHeading {
  /** The id the rendered heading carries, so a contents link can scroll to it. */
  id: string;
  /** The Markdown depth, 1 to 6, not the rendered one: the outline keeps the real structure. */
  level: number;
  /** The heading's words, without its Markdown marks. */
  text: string;
}

const headingId = (i: number) => `h-${i}`;

/** Every heading in reading order. Rendering and the contents list both number headings this way. */
function headingNodes(top: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const walk = (n: SyntaxNode) => {
    for (const c of children(n)) {
      if (HEADING.test(c.name)) out.push(c);
      else if (CONTAINERS.has(c.name)) walk(c);
    }
  };
  walk(top);
  return out;
}

/** The article's headings for its contents list, with the ids ArticleBody gives them. */
export function articleHeadings(text: string): ArticleHeading[] {
  return headingNodes(md.parse(text).topNode)
    .map((n, i) => ({
      id: headingId(i),
      level: Number(HEADING.exec(n.name)?.[1]),
      text: plain(n, text).replace(/\s+/g, " ").trim(),
    }))
    .filter((h) => h.text !== "");
}

export function ArticleBody({ text, markdown }: { text: string; markdown: boolean }) {
  if (!markdown) {
    return (
      <>
        {text
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l, i) => (
            <p key={i} data-para={i + 1}>
              {l}
            </p>
          ))}
      </>
    );
  }
  const tree = md.parse(text);
  const ids = new Map<number, string>(headingNodes(tree.topNode).map((n, i): [number, string] => [n.from, headingId(i)]));
  // Each top-level block carries its paragraph number, the one the model cites as [¶n] (see reader/paragraphs.ts).
  return (
    <>
      {topBlocks(tree.topNode).map((c, i) => numbered(block(c, text, i, ids, ARTICLE), i + 1))}
    </>
  );
}

/** Marks a drawn block with its paragraph number, so a citation can find it in the page. */
function numbered(el: ReactNode, n: number): ReactNode {
  return isValidElement<Record<string, unknown>>(el) ? cloneElement(el, { "data-para": n }) : el;
}

/**
 * A model answer, drawn as Markdown with no images and no outside links. Safe to call while the text
 * streams. With `cite`, the labels it writes ([Page 3], [Pages 3, 4] for a PDF, [¶7] for an article)
 * become buttons, where the number was sent to the model.
 */
export function AnswerBody({ text, cite }: { text: string; cite?: Cite }) {
  const src = cite ? citeMarkup(text) : escapeLabels(text);
  const tree = md.parse(src);
  return <>{blocks(tree.topNode, src, new Map(), { ai: true, cite })}</>;
}

/** Both label forms a model writes: "Page 3" / "Pages 3, 4", and "¶7" / "¶3, 4" / "¶ 3". */
const LABEL = /\[(Pages?|¶)\s?([\d][\d ,]*)\]/g;

/** Turns the labels a model writes into links, which the renderer checks against the numbers it was given. */
function citeMarkup(text: string): string {
  return text.replace(LABEL, (_m, word: string, list: string) => {
    const scheme = word === "¶" ? "para" : "page";
    return list
      .split(/[ ,]+/)
      .filter(Boolean)
      .map((p) => `[${scheme === "para" ? "¶" : "Page"} ${p}](cite:${scheme}/${p})`)
      .join(", ");
  });
}

/** Without a citation target, a label is ordinary text: its brackets are escaped so the parser keeps them. */
const escapeLabels = (text: string) => text.replace(LABEL, (m) => m.replace("[", "\\[").replace("]", "\\]"));

/** A citation as a button when its number was sent to the model and it names the kind of this answer; plain text otherwise. */
function citeChip(kind: CiteKind, n: number, key: number, cite: Cite): ReactNode {
  const label = kind === "para" ? `¶${n}` : `Page ${n}`;
  return cite.kind === kind && cite.numbers.has(n) ? (
    <button key={key} type="button" className="cite" onClick={() => cite.onOpen(n)}>
      {label}
    </button>
  ) : (
    <span key={key}>{label}</span>
  );
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function blocks(node: SyntaxNode, src: string, ids: Map<number, string>, o: Opts): ReactNode[] {
  return children(node)
    .filter((c) => !MARKS.has(c.name))
    .map((c, i) => block(c, src, i, ids, o));
}

function block(n: SyntaxNode, src: string, key: number, ids: Map<number, string>, o: Opts): ReactNode {
  const h = HEADING.exec(n.name);
  if (h) {
    // The item's title is the page's h1, so an article's headings start at h2; an answer's start at h3.
    const level = Number(h[1]);
    const Tag = (o.ai ? (level <= 2 ? "h3" : "h4") : `h${Math.min(6, level + 1)}`) as "h2";
    return (
      <Tag key={key} id={ids.get(n.from)}>
        {inline(n, src, n.from, n.to, o)}
      </Tag>
    );
  }
  switch (n.name) {
    case "Paragraph":
      return <p key={key}>{inline(n, src, n.from, n.to, o)}</p>;
    case "Blockquote":
      return <blockquote key={key}>{blocks(n, src, ids, o)}</blockquote>;
    case "BulletList":
      return <ul key={key}>{blocks(n, src, ids, o)}</ul>;
    case "OrderedList": {
      const start = parseInt(src.slice(n.from, n.to), 10);
      return (
        <ol key={key} start={start > 1 ? start : undefined}>
          {blocks(n, src, ids, o)}
        </ol>
      );
    }
    case "ListItem":
      return <li key={key}>{blocks(n, src, ids, o)}</li>;
    case "FencedCode": {
      const code = n.getChild("CodeText");
      return (
        <pre key={key}>
          <code>{code ? src.slice(code.from, code.to) : ""}</code>
        </pre>
      );
    }
    case "CodeBlock":
      return (
        <pre key={key}>
          <code>
            {src
              .slice(n.from, n.to)
              .split("\n")
              .map((l) => l.replace(/^ {1,4}|^\t/, ""))
              .join("\n")}
          </code>
        </pre>
      );
    case "HorizontalRule":
      return <hr key={key} />;
    case "Table":
      return (
        <div key={key} className="table-wrap">
          <table>
            <tbody>
              {children(n)
                .filter((r) => r.name === "TableHeader" || r.name === "TableRow")
                .map((r, i) => (
                  <tr key={i}>
                    {children(r)
                      .filter((c) => c.name === "TableCell")
                      .map((c, j) => {
                        const Cell = r.name === "TableHeader" ? "th" : "td";
                        return <Cell key={j}>{inline(c, src, c.from, c.to, o)}</Cell>;
                      })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      );
    case "HTMLBlock":
    case "CommentBlock":
    case "LinkReference":
    case "ProcessingInstructionBlock":
      return null;
    default:
      return <p key={key}>{inline(n, src, n.from, n.to, o)}</p>;
  }
}

/** Inline content: the text between child nodes, with each child drawn by kind. */
function inline(n: SyntaxNode, src: string, from: number, to: number, o: Opts): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = from;
  let key = 0;
  for (const c of children(n)) {
    if (c.to <= from || c.from >= to) continue;
    if (c.from > pos) out.push(src.slice(pos, c.from));
    pos = c.to;
    const el = inlineNode(c, src, key++, o);
    if (el !== null) out.push(el);
  }
  if (to > pos) out.push(src.slice(pos, to));
  // Leading/trailing spaces of a block (and heading marks' padding) don't belong to the text.
  if (typeof out[0] === "string") out[0] = out[0].replace(/^\s+/, "");
  const last = out.length - 1;
  if (typeof out[last] === "string") out[last] = (out[last] as string).replace(/\s+$/, "");
  return out;
}

/** A heading's words as a reader sees them: its marks and formatting dropped, its text kept. */
function plain(n: SyntaxNode, src: string): string {
  let out = "";
  let pos = n.from;
  for (const c of children(n)) {
    out += src.slice(pos, c.from);
    pos = c.to;
    if (c.name === "Autolink") out += src.slice(c.from, c.to).replace(/^<|>$/g, "");
    else if (c.name === "Escape") out += src.slice(c.from + 1, c.to);
    else if (c.name === "Entity") out += decodeEntity(src.slice(c.from, c.to));
    else if (!MARKS.has(c.name)) out += plain(c, src);
  }
  return out + src.slice(pos, n.to);
}

/** Text between a node's opening and closing marks. */
function inner(n: SyntaxNode, src: string, o: Opts): ReactNode[] {
  const kids = children(n);
  const open = kids.find((k) => MARKS.has(k.name));
  const marks = kids.filter((k) => k.name === "EmphasisMark" || k.name === "CodeMark" || k.name === "StrikethroughMark" || k.name === "LinkMark");
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
  return inline(n, src, open && open.from === n.from ? open.to : n.from, close ? close.from : n.to, o);
}

function inlineNode(c: SyntaxNode, src: string, key: number, o: Opts): ReactNode {
  switch (c.name) {
    case "Emphasis":
      return <em key={key}>{inner(c, src, o)}</em>;
    case "StrongEmphasis":
      return <strong key={key}>{inner(c, src, o)}</strong>;
    case "Strikethrough":
      return <del key={key}>{inner(c, src, o)}</del>;
    case "InlineCode":
      return <code key={key}>{inner(c, src, o)}</code>;
    case "Escape":
      return src.slice(c.from + 1, c.to);
    case "Entity":
      return decodeEntity(src.slice(c.from, c.to));
    case "HardBreak":
      return <br key={key} />;
    case "Link": {
      const url = c.getChild("URL");
      const target = url ? src.slice(url.from, url.to) : "";
      const cited = o.cite ? /^cite:(page|para)\/(\d+)$/.exec(target) : null;
      if (cited && o.cite) return citeChip(cited[1] as CiteKind, Number(cited[2]), key, o.cite);
      const href = url ? safeUrl(target) : undefined;
      const marks = c.getChildren("LinkMark");
      const text = inline(c, src, marks[0]?.to ?? c.from, marks[1]?.from ?? c.to, o);
      return href && !o.ai ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {text}
        </a>
      ) : (
        <span key={key}>{text}</span>
      );
    }
    case "Autolink":
    case "URL": {
      const raw = src.slice(c.from, c.to).replace(/^<|>$/g, "");
      const href = safeUrl(raw);
      return href && !o.ai ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {raw}
        </a>
      ) : (
        raw
      );
    }
    case "Image": {
      const url = c.getChild("URL");
      const src2 = url ? safeUrl(src.slice(url.from, url.to)) : undefined;
      const marks = c.getChildren("LinkMark");
      const alt = src.slice(marks[0]?.to ?? c.from, marks[1]?.from ?? c.from).replace(/\\(.)/g, "$1");
      // An answer never fetches an image: its address would be requested by the browser. It keeps the alt text.
      if (o.ai) return alt ? <span key={key}>{alt}</span> : null;
      return src2 ? <img key={key} src={src2} alt={alt} loading="lazy" referrerPolicy="no-referrer" /> : null;
    }
    default:
      return MARKS.has(c.name) ? null : <span key={key}>{inline(c, src, c.from, c.to, o)}</span>;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntity(e: string): string {
  const m = /^&(#x[0-9a-f]+|#\d+|\w+);$/i.exec(e);
  if (!m) return e;
  const v = m[1];
  if (v[0] === "#") {
    const code = v[1] === "x" || v[1] === "X" ? parseInt(v.slice(2), 16) : parseInt(v.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return e;
    }
  }
  return ENTITIES[v.toLowerCase()] ?? e;
}
