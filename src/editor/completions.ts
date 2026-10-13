import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type HighlightChoice, linkText, today, unescapeTitle } from "../notes/links";

/*
 * Typing "/" offers blocks (headings, lists, to-dos, quotes, code), and "[[" offers the titles
 * of everything in the folder. Both only ever insert plain Markdown.
 */

/** Replace "/command" with `text`, leaving the cursor `cursorBack` characters from its end. */
function insert(text: string, cursorBack = 0) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const at = from - 1; // include the "/"
    view.dispatch({
      changes: { from: at, to, insert: text },
      selection: EditorSelection.cursor(at + text.length - cursorBack),
      userEvent: "input.complete",
    });
  };
}

const SLASH: Completion[] = [
  { label: "Heading 1", detail: "#", apply: insert("# ") },
  { label: "Heading 2", detail: "##", apply: insert("## ") },
  { label: "Heading 3", detail: "###", apply: insert("### ") },
  { label: "Bulleted list", detail: "-", apply: insert("- ") },
  { label: "Numbered list", detail: "1.", apply: insert("1. ") },
  { label: "To-do", detail: "- [ ]", apply: insert("- [ ] ") },
  { label: "Quote", detail: ">", apply: insert("> ") },
  { label: "Code block", detail: "```", apply: insert("```\n\n```", 4) },
  { label: "Divider", detail: "---", apply: insert("---\n") },
  { label: "Math", detail: "$$", apply: insert("$$\n\n$$", 3) },
  {
    label: "Link to an item",
    detail: "[[",
    apply: (view, c, from, to) => {
      insert("[[")(view, c, from, to);
      startCompletion(view);
    },
  },
  {
    label: "Embed a highlight",
    detail: "![[",
    apply: (view, c, from, to) => {
      insert("![[")(view, c, from, to);
      startCompletion(view);
    },
  },
  { label: "Table", detail: "| |", apply: insert("|  |  |\n| --- | --- |\n|  |  |\n", 28) },
  { label: "Today's date", detail: "", apply: (view, c, from, to) => insert(today())(view, c, from, to) },
];

function slashCommands(context: CompletionContext): CompletionResult | null {
  // A "/" at the start of a line or after a space; not inside a word or a URL.
  // At most two words after it ("heading 1"), so ordinary prose with a slash isn't interrupted for long.
  const m = context.matchBefore(/(?:^|\s)\/\w*(?: \w*)?$/);
  if (!m) return null;
  const from = m.from + m.text.indexOf("/") + 1;
  return { from, options: SLASH, validFor: /^\w*(?: \w*)?$/ };
}

/** A title offered after "[[". With an id, two items of the same title can each be linked to. */
export interface TitleChoice {
  title: string;
  id?: string;
  /** Tells same-titled items apart in the list: a type, a date, a folder. */
  detail?: string;
}

/** Replace what was typed after "[[" (and a closing "]]" already there) with `text` and the closing brackets. */
function insertLink(text: string) {
  return (view: EditorView, _c: Completion, f: number, to: number) => {
    const closing = view.state.doc.sliceString(to, to + 2) === "]]" ? 2 : 0;
    view.dispatch({
      changes: { from: f, to: to + closing, insert: `${text}]]` },
      selection: EditorSelection.cursor(f + text.length + 2),
      userEvent: "input.complete",
    });
  };
}

/**
 * The choices after "[[". A title a link can't hold as it is ([ ] | #) is escaped, so the link
 * still leads to it. Titles shared by several items say so: with their ids, each gets its own
 * link; without, one choice stands for them all and leads where a link by that title always does.
 */
export function titleOptions(titles: (string | TitleChoice)[]): Completion[] {
  const all = titles.map((t) => (typeof t === "string" ? { title: t } : t)).filter((t) => t.title.trim());
  const key = (t: string) => t.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const t of all) counts.set(key(t.title), (counts.get(key(t.title)) ?? 0) + 1);
  const offered = new Set<string>();
  const out: Completion[] = [];
  for (const t of all) {
    const n = counts.get(key(t.title))!;
    if (n === 1) {
      out.push({ label: t.title, type: "text", apply: insertLink(linkText(t.title)) });
    } else if (t.id) {
      const shown = t.title.trim().replace(/\[/g, "(").replace(/\]/g, ")");
      out.push({ label: t.title, detail: t.detail ?? `one of ${n}`, type: "text", apply: insertLink(`${t.id}|${shown}`) });
    } else if (!offered.has(key(t.title))) {
      offered.add(key(t.title));
      out.push({
        label: t.title,
        detail: `${n} items share this title`,
        info: "A link by this title opens the one whose title matches exactly, else the oldest. Rename one to tell them apart.",
        type: "text",
        apply: insertLink(linkText(t.title)),
      });
    }
  }
  return out;
}

function wikiLinks(titles: () => (string | TitleChoice)[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const m = context.matchBefore(/\[\[[^[\]\n|#]*$/);
    if (!m) return null;
    return { from: m.from + 2, options: titleOptions(titles()), validFor: /^[^[\]\n|#]*$/ };
  };
}

/** After "[[Title#": the highlights in that item, so a link (or embed) can point at one. */
function highlightLinks(highlights: (title: string) => Promise<HighlightChoice[]>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const m = context.matchBefore(/\[\[([^[\]\n|#]+)#\^?[\w]*$/);
    if (!m) return null;
    const title = /\[\[([^[\]\n|#]+)#/.exec(m.text)![1];
    // A title with [ ] | # in it is written escaped in a link; look it up as it really is.
    const choices = await highlights(unescapeTitle(title.trim()));
    if (!choices.length) return null;
    const from = m.from + 2 + title.length + 1;
    return {
      from,
      filter: false,
      options: choices.map((h) => ({
        label: h.quote.length > 70 ? `${h.quote.slice(0, 70)}…` : h.quote,
        detail: h.page ? `p. ${h.page}` : undefined,
        type: "text",
        apply: (view: EditorView, _c: Completion, f: number, to: number) => {
          const closing = view.state.doc.sliceString(to, to + 2) === "]]" ? 2 : 0;
          const text = `^${h.ref}]]`;
          view.dispatch({
            changes: { from: f, to: to + closing, insert: text },
            selection: EditorSelection.cursor(f + text.length),
            userEvent: "input.complete",
          });
        },
      })),
    };
  };
}

export interface CompletionData {
  titles: () => (string | TitleChoice)[];
  highlights: (title: string) => Promise<HighlightChoice[]>;
}

export function completionSources(data: CompletionData) {
  return [slashCommands, highlightLinks(data.highlights), wikiLinks(data.titles)];
}
