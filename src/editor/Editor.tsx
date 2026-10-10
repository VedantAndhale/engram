import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { completionSources } from "./completions";
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
  titles: () => string[];
  openWiki: (title: string) => void;
  autoFocus?: boolean;
  label?: string;
}

/**
 * A Markdown editor with live preview. The text it produces is exactly what goes in the file.
 * Changes from elsewhere (another device syncing in) replace the text only while you aren't in it.
 */
export function Editor({ value, onChange, placeholder, titles, openWiki, autoFocus, label }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The latest callbacks, so the editor is created once.
  const props = useRef({ onChange, titles, openWiki });
  props.current = { onChange, titles, openWiki };

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
            { key: "Mod-b", run: wrap("**") },
            { key: "Mod-i", run: wrap("*") },
            { key: "Mod-e", run: wrap("`") },
            ...completionKeymap,
            ...markdownKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          autocompletion({ override: completionSources(() => props.current.titles()), icons: false }),
          livePreview({ openWiki: (t) => props.current.openWiki(t) }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label ?? "Note", spellcheck: "true", autocapitalize: "sentences" }),
          placeholder ? placeholderExt(placeholder) : [],
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) props.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || v.hasFocus) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, annotations: External.of(true) });
  }, [value]);

  return <div ref={host} className="md-editor" />;
}

export default Editor;
