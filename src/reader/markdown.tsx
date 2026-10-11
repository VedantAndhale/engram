import { GFM, parser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import type { ReactNode } from "react";

/*
 * A saved article, drawn for reading. The Markdown is parsed with the parser the editor already
 * ships and turned straight into React elements. The text is someone else's, so nothing in it
 * becomes HTML: tags in the text are dropped, and only http(s) links and images are kept.
 * Older saves are plain text: one paragraph per line.
 */

const md = parser.configure(GFM);

const MARKS = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "URL",
  "LinkTitle",
  "LinkLabel",
  "CodeInfo",
  "StrikethroughMark",
  "TableDelimiter",
  "TaskMarker",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
]);

const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);

export function ArticleBody({ text, markdown }: { text: string; markdown: boolean }) {
  if (!markdown) {
    return (
      <>
        {text
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l, i) => (
            <p key={i}>{l}</p>
          ))}
      </>
    );
  }
  const tree = md.parse(text);
  return <>{blocks(tree.topNode, text)}</>;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function blocks(node: SyntaxNode, src: string): ReactNode[] {
  return children(node)
    .filter((c) => !MARKS.has(c.name))
    .map((c, i) => block(c, src, i));
}

function block(n: SyntaxNode, src: string, key: number): ReactNode {
  const h = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
  if (h) {
    const Tag = `h${Math.min(6, Number(h[1]) + 1)}` as "h2"; // the item's title is the page's h1
    return <Tag key={key}>{inline(n, src)}</Tag>;
  }
  switch (n.name) {
    case "Paragraph":
      return <p key={key}>{inline(n, src)}</p>;
    case "Blockquote":
      return <blockquote key={key}>{blocks(n, src)}</blockquote>;
    case "BulletList":
      return <ul key={key}>{blocks(n, src)}</ul>;
    case "OrderedList": {
      const start = parseInt(src.slice(n.from, n.to), 10);
      return (
        <ol key={key} start={start > 1 ? start : undefined}>
          {blocks(n, src)}
        </ol>
      );
    }
    case "ListItem":
      return <li key={key}>{blocks(n, src)}</li>;
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
                        return <Cell key={j}>{inline(c, src)}</Cell>;
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
      return <p key={key}>{inline(n, src)}</p>;
  }
}

/** Inline content: the text between child nodes, with each child drawn by kind. */
function inline(n: SyntaxNode, src: string, from = n.from, to = n.to): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = from;
  let key = 0;
  for (const c of children(n)) {
    if (c.to <= from || c.from >= to) continue;
    if (c.from > pos) out.push(src.slice(pos, c.from));
    pos = c.to;
    const el = inlineNode(c, src, key++);
    if (el !== null) out.push(el);
  }
  if (to > pos) out.push(src.slice(pos, to));
  // Leading/trailing spaces of a block (and heading marks' padding) don't belong to the text.
  if (typeof out[0] === "string") out[0] = out[0].replace(/^\s+/, "");
  const last = out.length - 1;
  if (typeof out[last] === "string") out[last] = (out[last] as string).replace(/\s+$/, "");
  return out;
}

/** Text between a node's opening and closing marks. */
function inner(n: SyntaxNode, src: string): ReactNode[] {
  const kids = children(n);
  const open = kids.find((k) => MARKS.has(k.name));
  const marks = kids.filter((k) => k.name === "EmphasisMark" || k.name === "CodeMark" || k.name === "StrikethroughMark" || k.name === "LinkMark");
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
  return inline(n, src, open && open.from === n.from ? open.to : n.from, close ? close.from : n.to);
}

function inlineNode(c: SyntaxNode, src: string, key: number): ReactNode {
  switch (c.name) {
    case "Emphasis":
      return <em key={key}>{inner(c, src)}</em>;
    case "StrongEmphasis":
      return <strong key={key}>{inner(c, src)}</strong>;
    case "Strikethrough":
      return <del key={key}>{inner(c, src)}</del>;
    case "InlineCode":
      return <code key={key}>{inner(c, src)}</code>;
    case "Escape":
      return src.slice(c.from + 1, c.to);
    case "Entity":
      return decodeEntity(src.slice(c.from, c.to));
    case "HardBreak":
      return <br key={key} />;
    case "Link": {
      const url = c.getChild("URL");
      const href = url ? safeUrl(src.slice(url.from, url.to)) : undefined;
      const marks = c.getChildren("LinkMark");
      const text = inline(c, src, marks[0]?.to ?? c.from, marks[1]?.from ?? c.to);
      return href ? (
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
      return href ? (
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
      return src2 ? <img key={key} src={src2} alt={alt} loading="lazy" referrerPolicy="no-referrer" /> : null;
    }
    default:
      return MARKS.has(c.name) ? null : <span key={key}>{inline(c, src)}</span>;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

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
