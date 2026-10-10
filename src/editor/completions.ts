import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/*
 * Typing "/" offers blocks (headings, lists, to-dos, quotes, code), and "[[" offers the titles
 * of everything in the folder. Both only ever insert plain Markdown.
 */

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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
    const m = context.matchBefore(/\[\[[^[\]\n|]*$/);
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
      validFor: /^[^[\]\n|]*$/,
    };
  };
}

export function completionSources(titles: () => string[]) {
  return [slashCommands, wikiLinks(titles)];
}
