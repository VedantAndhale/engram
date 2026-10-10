import { completionStatus } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, Prec, type Range, StateEffect, StateField } from "@codemirror/state";
import { type Command, Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { EMBED_LINE, type EmbedData, parseTarget } from "../notes/links";

/*
 * Blocks that show as something other than text: tables, images and ![[embeds]]. Like the rest
 * of live preview, the Markdown shows as soon as the cursor is on one of their lines; clicking
 * one (anywhere but a link in it) puts the cursor there.
 *
 * Widgets that replace whole lines must come from a state field, not a view plugin, so this is
 * separate from livePreview.ts, and it tracks focus itself.
 */

export interface BlockHandlers {
  /** What ![[target]] shows; null when nothing has that title. */
  embed: (target: string) => Promise<EmbedData | null>;
}

const setFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setFocus) ? e.value : acc), v),
});

/** **bold**, *italic*, `code`, [[links]] and [text](url) inside a table cell or an embed. */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[\[[^[\]\n]+\]\])|(\[[^\]\n]+\]\([^)\s]+\))/g;

function renderInline(text: string, parent: HTMLElement) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) parent.append(text.slice(last, m.index));
    const s = m[0];
    let el: HTMLElement;
    if (m[1]) {
      el = document.createElement("code");
      el.className = "cm-inline-code";
      el.textContent = s.slice(1, -1);
    } else if (m[2]) {
      el = document.createElement("strong");
      el.textContent = s.slice(2, -2);
    } else if (m[3]) {
      el = document.createElement("em");
      el.textContent = s.slice(1, -1);
    } else if (m[4]) {
      const [target, shown] = s.slice(2, -2).split("|");
      el = document.createElement("span");
      el.className = "cm-wikilink";
      el.dataset.wiki = target.trim();
      el.textContent = (shown ?? parseTarget(target).title).trim();
    } else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      el = document.createElement("span");
      el.className = "cm-link";
      el.dataset.href = lm[2];
      el.textContent = lm[1];
    }
    parent.append(el);
    last = m.index! + s.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Split a table row on its pipes (a backslash-escaped \| stays in the cell). */
function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

class TableWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-block-widget cm-table-wrap";
    const table = wrap.appendChild(document.createElement("table"));
    const [head, delim, ...rows] = this.text.split("\n");
    const align = cells(delim ?? "").map((d) => (/^:-+:$/.test(d) ? "center" : /^-+:$/.test(d) ? "right" : ""));
    const row = (parent: HTMLElement, line: string, tag: "th" | "td") => {
      const tr = parent.appendChild(document.createElement("tr"));
      cells(line).forEach((c, i) => {
        const cell = tr.appendChild(document.createElement(tag));
        if (align[i]) cell.style.textAlign = align[i];
        renderInline(c, cell);
      });
    };
    row(table.appendChild(document.createElement("thead")), head, "th");
    const body = table.appendChild(document.createElement("tbody"));
    for (const r of rows) if (r.trim()) row(body, r, "td");
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    // Only web and inline images; anything else shows its description.
    if (!/^(https?:|data:image\/)/i.test(this.src)) {
      const s = document.createElement("span");
      s.className = "cm-image-missing";
      s.textContent = this.alt || this.src;
      return s;
    }
    const img = document.createElement("img");
    img.className = "cm-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly resolve: BlockHandlers["embed"],
  ) {
    super();
  }
  eq(other: EmbedWidget) {
    return other.target === this.target;
  }
  get estimatedHeight() {
    return 90;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-block-widget cm-embed is-loading";
    const { title, ref } = parseTarget(this.target);
    box.textContent = title;
    void this.resolve(this.target).then((data) => {
      box.classList.remove("is-loading");
      box.textContent = "";
      const source = document.createElement("div");
      source.className = "cm-embed-source";
      const link = source.appendChild(document.createElement("span"));
      link.className = "cm-wikilink";
      link.dataset.wiki = this.target;
      link.textContent = data?.title ?? title;
      if (!data || data.missing) {
        box.classList.add("is-missing");
        box.append(data ? `That highlight (^${ref}) isn't in ` : "Nothing called ", source, data ? " any more." : " yet.");
        source.className = "";
        return;
      }
      if (data.quote) {
        const q = box.appendChild(document.createElement("blockquote"));
        q.textContent = data.quote;
        if (data.note) renderInline(data.note, box.appendChild(document.createElement("p")));
        source.prepend("— ");
        if (data.page) source.append(`, page ${data.page}`);
        box.append(source);
      } else {
        box.append(source);
        if (data.excerpt) renderInline(data.excerpt, box.appendChild(document.createElement("p")));
      }
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState, handlers: BlockHandlers): DecorationSet {
  const doc = state.doc;
  const active = new Set<number>();
  if (state.field(focusField)) {
    for (const r of state.selection.ranges) {
      for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) active.add(n);
    }
  }
  const touched = (from: number, to: number) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) if (active.has(n)) return true;
    return false;
  };

  const decos: Range<Decoration>[] = [];
  const code: [number, number][] = [];
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      switch (node.name) {
        case "FencedCode":
        case "CodeBlock":
          code.push([node.from, node.to]);
          return false;
        case "Table": {
          const a = doc.lineAt(node.from);
          const b = doc.lineAt(node.to);
          if (!touched(a.from, b.to)) {
            decos.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(a.from, b.to)), block: true }).range(a.from, b.to));
          }
          return false;
        }
        case "Image": {
          if (touched(node.from, node.to)) return false;
          const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(doc.sliceString(node.from, node.to));
          if (m) decos.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to));
          return false;
        }
      }
    },
  });

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (active.has(n) || !line.text.includes("![[")) continue;
    const m = EMBED_LINE.exec(line.text);
    if (!m || code.some(([a, b]) => line.from >= a && line.from < b)) continue;
    decos.push(Decoration.replace({ widget: new EmbedWidget(m[1].trim(), handlers.embed), block: true }).range(line.from, line.to));
  }
  return Decoration.set(decos, true);
}


/**
 * Up and Down would jump over a rendered block, leaving no way to reach its Markdown from the
 * keyboard. Step into it instead: its first line going down, its last going up.
 */
function enterBlock(field: StateField<DecorationSet>, forward: boolean): Command {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || completionStatus(state)) return false;
    const line = state.doc.lineAt(sel.head);
    // Moving within a wrapped line is left to the default.
    if (state.doc.lineAt(view.moveVertically(sel, forward).head).number === line.number) return false;
    const n = line.number + (forward ? 1 : -1);
    if (n < 1 || n > state.doc.lines) return false;
    const next = state.doc.line(n);
    let hit: { from: number; to: number } | null = null;
    state.field(field).between(next.from, next.to, (from, to, d) => {
      if (d.spec.block && from <= next.from && to >= next.to) {
        hit = { from, to };
        return false;
      }
    });
    if (!hit) return false;
    const { from, to } = hit as { from: number; to: number };
    view.dispatch({ selection: { anchor: forward ? from : state.doc.lineAt(to).from }, scrollIntoView: true });
    return true;
  };
}

export function blocks(handlers: BlockHandlers) {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, handlers),
    update(deco, tr) {
      const refocused = tr.effects.some((e) => e.is(setFocus));
      if (tr.docChanged || tr.selection || refocused || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return build(tr.state, handlers);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Clicking a block (anywhere but a link in it) puts the cursor on its first line, which shows its Markdown.
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const target = e.target as HTMLElement;
      if (e.button !== 0 || target.closest("[data-wiki], [data-href]")) return false;
      const block = target.closest<HTMLElement>(".cm-block-widget, .cm-image, .cm-image-missing");
      if (!block) return false;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(block) } });
      view.focus();
      return true;
    },
  });

  const keys = Prec.high(
    keymap.of([
      { key: "ArrowDown", run: enterBlock(field, true) },
      { key: "ArrowUp", run: enterBlock(field, false) },
    ]),
  );

  return [focusField, EditorView.focusChangeEffect.of((_s, focusing) => setFocus.of(focusing)), field, clicks, keys];
}
