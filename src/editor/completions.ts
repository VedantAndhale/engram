import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type HighlightChoice, today } from "../notes/links";

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

function wikiLinks(titles: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const m = context.matchBefore(/\[\[[^[\]\n|#]*$/);
    if (!m) return null;
    const from = m.from + 2;
    return {
      from,
      options: titles().map((title) => ({
        label: title,
        type: "text",
        apply: (view: EditorView, _c: Completion, f: number, to: number) => {
          const closing = view.state.doc.sliceString(to, to + 2) === "]]" ? 2 : 0;
          view.dispatch({
            changes: { from: f, to: to + closing, insert: `${title}]]` },
            selection: EditorSelection.cursor(f + title.length + 2),
            userEvent: "input.complete",
          });
        },
      })),
      validFor: /^[^[\]\n|#]*$/,
    };
  };
}

/** After "[[Title#": the highlights in that item, so a link (or embed) can point at one. */
function highlightLinks(highlights: (title: string) => Promise<HighlightChoice[]>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const m = context.matchBefore(/\[\[([^[\]\n|#]+)#\^?[\w]*$/);
    if (!m) return null;
    const title = /\[\[([^[\]\n|#]+)#/.exec(m.text)![1];
    const choices = await highlights(title);
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
  titles: () => string[];
  highlights: (title: string) => Promise<HighlightChoice[]>;
}

export function completionSources(data: CompletionData) {
  return [slashCommands, highlightLinks(data.highlights), wikiLinks(data.titles)];
}
