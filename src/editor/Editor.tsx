import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, foldKeymap, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Pilcrow,
  Quote,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Menu, type MenuItem } from "../ui/common";
import type { EmbedData, HighlightChoice } from "../notes/links";
import { pictureIn, pictureMarkdown } from "../notes/images";
import { blocks } from "./blocks";
import { completionSources, type TitleChoice } from "./completions";
import { type BlockAction, blockHandles } from "./handles";
import { livePreview } from "./livePreview";

/** Marks text replaced from outside (a sync), so it isn't reported back as an edit. */
const External = Annotation.define<boolean>();

/** Wrap the selection in `mark` (bold, italic, code), or unwrap it if it already is. */
const wrap =
  (markText: string): StateCommand =>
  ({ state, dispatch }) => {
    const n = markText.length;
    dispatch(
      state.update(
        state.changeByRange((r) => {
          const before = state.sliceDoc(r.from - n, r.from);
          const after = state.sliceDoc(r.to, r.to + n);
          if (before === markText && after === markText) {
            return {
              changes: [
                { from: r.from - n, to: r.from },
                { from: r.to, to: r.to + n },
              ],
              range: EditorSelection.range(r.from - n, r.to - n),
            };
          }
          return {
            changes: [
              { from: r.from, insert: markText },
              { from: r.to, insert: markText },
            ],
            range: EditorSelection.range(r.from + n, r.to + n),
          };
        }),
        { userEvent: "input" },
      ),
    );
    return true;
  };

// Colors and fonts come from the app's theme variables, so light, sepia and dark all apply.
const ICONS: Record<string, ReactNode> = {
  text: <Pilcrow size={15} />,
  h1: <Heading1 size={15} />,
  h2: <Heading2 size={15} />,
  h3: <Heading3 size={15} />,
  bullet: <List size={15} />,
  number: <ListOrdered size={15} />,
  todo: <CheckSquare size={15} />,
  quote: <Quote size={15} />,
  up: <ArrowUp size={15} />,
  down: <ArrowDown size={15} />,
  duplicate: <Copy size={15} />,
  delete: <Trash2 size={15} />,
};

const highlight = HighlightStyle.define([
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { tag: tags.meta, color: "var(--muted)" },
  { tag: tags.processingInstruction, color: "var(--muted)" },
  { tag: tags.url, color: "var(--muted)" },
]);

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Titles offered after "[[". Read on each keystroke, so it can change. */
  titles: () => (string | TitleChoice)[];
  /** Open what a [[link]] names; the target may end in #^ref for one highlight. */
  openWiki: (target: string) => void;
  /** The highlights in the item a title names, offered after "[[Title#". */
  highlights: (title: string) => Promise<HighlightChoice[]>;
  /** What ![[target]] shows. */
  embed: (target: string) => Promise<EmbedData | null>;
  autoFocus?: boolean;
  label?: string;
  /** Ctrl+Enter (Cmd+Enter on a Mac) calls this, to save. Without it, the key starts a new line as usual. */
  onSubmit?: () => void;
  /** Called when focus leaves the editor. Not called while its own block menu has the focus. */
  onBlur?: () => void;
}

/**
 * A Markdown editor with live preview. The text it produces is exactly what goes in the file.
 * Changes from elsewhere (another device syncing in) wait while you type, and land once you leave
 * the editor, unless you changed the text yourself in the meantime (then your words win).
 */
export function Editor({ value, onChange, placeholder, titles, openWiki, highlights, embed, autoFocus, label, onSubmit, onBlur }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  // The block menu takes the focus when it opens, which is not leaving the note.
  const menuOpen = useRef(false);
  const showMenu = (anchor: HTMLElement, actions: BlockAction[]) => {
    menuOpen.current = true;
    setMenu({ anchor, items: actions.map(({ id, ...a }) => ({ ...a, icon: ICONS[id] })) });
  };
  // The latest callbacks, so the editor is created once.
  const props = useRef({ onChange, titles, openWiki, highlights, embed, onSubmit, onBlur });
  props.current = { onChange, titles, openWiki, highlights, embed, onSubmit, onBlur };
  // The latest saved text, and the last saved text the editor was known to match. A synced change
  // that arrived while you were typing is applied when you leave, unless you've typed since.
  const saved = useRef(value);
  saved.current = value;
  const base = useRef(value);

  const takeSaved = (v: EditorView) => {
    const cur = v.state.doc.toString();
    if (cur === saved.current) base.current = cur;
    else if (cur === base.current) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: saved.current }, annotations: External.of(true) });
      base.current = saved.current;
    }
  };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown({ base: markdownLanguage, addKeymap: false }),
          syntaxHighlighting(highlight),
          keymap.of([
            // Saves when the caller asks for it. Otherwise it returns false, and the key starts a new line as usual.
            {
              key: "Mod-Enter",
              run: () => {
                const submit = props.current.onSubmit;
                if (!submit) return false;
                submit();
                return true;
              },
            },
            { key: "Mod-b", run: wrap("**") },
            { key: "Mod-i", run: wrap("*") },
            { key: "Mod-e", run: wrap("`") },
            ...completionKeymap,
            ...foldKeymap,
            ...markdownKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          autocompletion({
            override: completionSources({ titles: () => props.current.titles(), highlights: (t) => props.current.highlights(t) }),
            icons: false,
          }),
          livePreview({ openWiki: (t) => props.current.openWiki(t) }),
          blocks({ embed: (t) => props.current.embed(t) }),
          codeFolding({ placeholderText: "…" }),
          blockHandles({ menu: showMenu }),
          // A screenshot on the clipboard goes in at the cursor, as a picture kept in the note (notes/images.ts).
          EditorView.domEventHandlers({
            paste(event, view) {
              const picture = pictureIn(event.clipboardData);
              if (!picture) return false;
              event.preventDefault();
              void pictureMarkdown(picture).then((markdown) => {
                const sel = view.state.selection.main;
                view.dispatch({ changes: { from: sel.from, to: sel.to, insert: markdown }, selection: { anchor: sel.from + markdown.length } });
              });
              return true;
            },
          }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label ?? "Note", spellcheck: "true", autocapitalize: "sentences" }),
          placeholder ? placeholderExt(placeholder) : [],
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) props.current.onChange(u.state.doc.toString());
            if (u.focusChanged && !u.view.hasFocus)
              queueMicrotask(() => {
                if (!view.current) return;
                takeSaved(view.current);
                // Switching to another window blurs the editor too, but the note is still being written. Only
                // leaving for something else in this window counts.
                if (!menuOpen.current && !view.current.hasFocus && document.hasFocus()) props.current.onBlur?.();
              });
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) {
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      v.focus();
    }
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v) {
      const cur = v.state.doc.toString();
      if (cur === value) base.current = value;
      else if (!v.hasFocus) takeSaved(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <>
      <div ref={host} className="md-editor" />
      {menu && (
        <Menu
          anchor={menu.anchor}
          items={menu.items}
          align="start"
          onClose={(reason) => {
            setMenu(null);
            menuOpen.current = false;
            setTimeout(() => {
              // A press outside the menu, in an editor with onBlur. The menu held the focus, so the editor never blurred: a press
              // in the note (its gutter included) takes the focus back, and a press elsewhere leaves the note.
              if (reason?.away && props.current.onBlur) {
                if (reason.away instanceof Node && host.current?.contains(reason.away)) view.current?.focus();
                else if (view.current && !view.current.hasFocus) props.current.onBlur();
                return;
              }
              // Closed from the keyboard, or by a press elsewhere: back to writing.
              if (document.activeElement === document.body) view.current?.focus();
            });
          }}
        />
      )}
    </>
  );
}

export default Editor;
