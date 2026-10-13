import { ensureSyntaxTree, foldable, foldedRanges, foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { type EditorState, MapMode, Prec, StateEffect, StateField } from "@codemirror/state";
import { type Command, EditorView, gutter, GutterMarker, keymap, ViewPlugin } from "@codemirror/view";
import { EMBED_LINE } from "../notes/links";

/*
 * Notion-style blocks on top of plain Markdown. Each paragraph, heading, list item, quote, code
 * block, table and embed gets a grip beside it (on hover, or where the cursor is): drag it to
 * move the block, or click it for a menu. Headings and list items with more under them fold.
 * Every action is an edit to the Markdown text, so the file stays clean.
 */

export type BlockKind = "text" | "heading" | "list" | "quote" | "code" | "table" | "rule" | "embed" | "math" | "other";

export interface Block {
  from: number;
  to: number;
  kind: BlockKind;
}

export interface BlockAction {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface HandleHandlers {
  /** Show `actions` in a menu next to `anchor` (the grip). */
  menu: (anchor: HTMLElement, actions: BlockAction[]) => void;
}

/** The top-level blocks, in order. A list contributes each of its items (with what's nested in it). */
export function blocksOf(state: EditorState): Block[] {
  let out = cache.get(state);
  if (!out) cache.set(state, (out = findBlocks(state)));
  return out;
}

const cache = new WeakMap<EditorState, Block[]>();

function findBlocks(state: EditorState): Block[] {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const out: Block[] = [];
  const push = (from: number, to: number, kind: BlockKind) => {
    let last = doc.lineAt(to);
    if (last.from === to && to > from) last = doc.lineAt(to - 1);
    out.push({ from: doc.lineAt(from).from, to: last.to, kind });
  };
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const name = node.name;
    if (name === "BulletList" || name === "OrderedList") {
      for (let item = node.firstChild; item; item = item.nextSibling) if (item.name === "ListItem") push(item.from, item.to, "list");
      continue;
    }
    let kind: BlockKind = "other";
    if (/^ATXHeading\d$/.test(name)) kind = "heading";
    else if (name === "Paragraph") {
      const text = doc.sliceString(node.from, node.to);
      kind = EMBED_LINE.test(text.trim()) ? "embed" : text.trimStart().startsWith("$$") ? "math" : "text";
    } else if (name === "Blockquote") kind = "quote";
    else if (name === "FencedCode" || name === "CodeBlock") kind = "code";
    else if (name === "Table") kind = "table";
    else if (name === "HorizontalRule") kind = "rule";
    push(node.from, node.to, kind);
  }
  return out;
}

const blockAt = (blocks: Block[], pos: number) => blocks.findIndex((b) => pos >= b.from && pos <= b.to);

/** What goes between two blocks that weren't next to each other: list items stay one list. */
const gap = (a: Block, b: Block) => (a.kind === "list" && b.kind === "list" ? "\n" : "\n\n");

/**
 * Rewrite the blocks in a new `order` (indices into `blocks`, repeats allowed), changing only the
 * text that differs, and put the cursor at the start of the block at `focus` in that order.
 */
function rearrange(view: EditorView, blocks: Block[], order: number[], focus: number) {
  const doc = view.state.doc;
  const start = blocks[0].from;
  const end = blocks[blocks.length - 1].to;
  let out = "";
  let cursor = 0;
  order.forEach((bi, k) => {
    if (k > 0) {
      const prev = order[k - 1];
      out += prev + 1 === bi ? doc.sliceString(blocks[prev].to, blocks[bi].from) : gap(blocks[prev], blocks[bi]);
    }
    if (k === focus) cursor = out.length;
    out += doc.sliceString(blocks[bi].from, blocks[bi].to);
  });
  const old = doc.sliceString(start, end);
  let p = 0;
  while (p < old.length && p < out.length && old[p] === out[p]) p++;
  let s = 0;
  while (s < old.length - p && s < out.length - p && old[old.length - 1 - s] === out[out.length - 1 - s]) s++;
  view.dispatch({
    changes: { from: start + p, to: end - s, insert: out.slice(p, out.length - s) },
    selection: { anchor: start + cursor },
    scrollIntoView: true,
    userEvent: "move",
  });
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Move block `i` so it lands before block `dest` (`blocks.length` for the end). */
function moveTo(view: EditorView, blocks: Block[], i: number, dest: number) {
  if (dest === i || dest === i + 1) return;
  const order = range(blocks.length).filter((k) => k !== i);
  const at = dest > i ? dest - 1 : dest;
  order.splice(at, 0, i);
  rearrange(view, blocks, order, at);
}

const MARKER = /^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;

export type TurnInto = "text" | "h1" | "h2" | "h3" | "bullet" | "number" | "todo" | "quote";

/** Rewrite a text, heading, list or quote block as another of those. */
function turnInto(view: EditorView, b: Block, to: TurnInto) {
  let lines = view.state.doc.sliceString(b.from, b.to).split("\n");
  if (b.kind === "quote") lines = lines.map((l) => l.replace(/^\s*> ?/, ""));
  // A heading is one line; soft-wrapped lines of a paragraph join into it.
  if (to.startsWith("h") && (b.kind === "text" || b.kind === "quote")) lines = [lines.map((l) => l.trim()).join(" ")];
  lines[0] = lines[0].replace(MARKER, "$1");
  const prefix = { text: "", h1: "# ", h2: "## ", h3: "### ", bullet: "- ", number: "1. ", todo: "- [ ] ", quote: "" }[to];
  lines[0] = lines[0].replace(/^(\s*)/, `$1${prefix}`);
  if (to === "quote") lines = lines.map((l) => `> ${l}`);
  const insert = lines.join("\n");
  view.dispatch({ changes: { from: b.from, to: b.to, insert }, selection: { anchor: b.from + insert.length }, userEvent: "input" });
}

const CHANGEABLE: BlockKind[] = ["text", "heading", "list", "quote"];

function actions(view: EditorView, blocks: Block[], i: number): BlockAction[] {
  const b = blocks[i];
  // The block numbers are for the text as it was when the menu opened. If the text has changed since (a drag, or a
  // synced change), a pick does nothing, rather than rewriting the wrong text.
  const opened = view.state.doc;
  const done = (f: () => void) => () => {
    if (view.state.doc === opened) f();
    view.focus();
  };
  const turn = (id: TurnInto, label: string): BlockAction => ({
    id,
    label,
    disabled: !CHANGEABLE.includes(b.kind),
    run: done(() => turnInto(view, b, id)),
  });
  return [
    turn("text", "Text"),
    turn("h1", "Heading 1"),
    turn("h2", "Heading 2"),
    turn("h3", "Heading 3"),
    turn("bullet", "Bulleted list"),
    turn("number", "Numbered list"),
    turn("todo", "To-do"),
    turn("quote", "Quote"),
    { id: "up", label: "Move up", disabled: i === 0, run: done(() => moveTo(view, blocks, i, i - 1)) },
    { id: "down", label: "Move down", disabled: i === blocks.length - 1, run: done(() => moveTo(view, blocks, i, i + 2)) },
    {
      id: "duplicate",
      label: "Duplicate",
      run: done(() => {
        const order = range(blocks.length);
        order.splice(i + 1, 0, i);
        rearrange(view, blocks, order, i + 1);
      }),
    },
    {
      id: "delete",
      label: "Delete",
      danger: true,
      run: done(() => {
        const order = range(blocks.length).filter((k) => k !== i);
        rearrange(view, blocks, order, Math.min(i, order.length - 1));
      }),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Which block shows its grip: the one under the mouse, else (while editing) the cursor's.
// ---------------------------------------------------------------------------------------------

const setHover = StateEffect.define<number>();
const hoverField = StateField.define<number>({
  create: () => -1,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHover)) v = e.value;
    return v >= 0 && tr.docChanged ? tr.changes.mapPos(v) : v;
  },
});

/**
 * The start of the block being dragged, kept in step with every change to the text while the
 * drag goes on (a synced change, an undo), or null once that block's start was deleted.
 */
const setDrag = StateEffect.define<number | null>();
const dragField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDrag)) v = e.value;
    return v !== null && tr.docChanged ? tr.changes.mapPos(v, 1, MapMode.TrackDel) : v;
  },
});

/** The start of the block whose grip shows, or -1. */
function shownBlock(view: EditorView): number {
  const hover = view.state.field(hoverField);
  if (hover >= 0) return hover;
  if (!view.hasFocus) return -1;
  const blocks = blocksOf(view.state);
  const i = blockAt(blocks, view.state.selection.main.head);
  return i < 0 ? -1 : blocks[i].from;
}

/** The block the pointer is level with, wherever it is across the editor. */
function blockUnder(view: EditorView, y: number): { blocks: Block[]; i: number } {
  const blocks = blocksOf(view.state);
  const box = view.contentDOM.getBoundingClientRect();
  const pos = view.posAtCoords({ x: box.left + 4, y: Math.min(Math.max(y, box.top + 1), box.bottom - 1) }, false);
  return { blocks, i: blockAt(blocks, pos) };
}

const GRIP =
  '<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"><g fill="currentColor"><circle cx="3.5" cy="3" r="1.4"/><circle cx="8.5" cy="3" r="1.4"/><circle cx="3.5" cy="8" r="1.4"/><circle cx="8.5" cy="8" r="1.4"/><circle cx="3.5" cy="13" r="1.4"/><circle cx="8.5" cy="13" r="1.4"/></g></svg>';
const CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

class HandleMarker extends GutterMarker {
  constructor(
    readonly grip: boolean,
    readonly fold: "none" | "open" | "folded",
  ) {
    super();
  }
  eq(other: HandleMarker) {
    return other.grip === this.grip && other.fold === this.fold;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-handle";
    if (this.fold !== "none") {
      const t = box.appendChild(document.createElement("button"));
      t.className = `cm-fold-toggle ${this.fold === "folded" ? "is-folded" : ""}`;
      t.innerHTML = CHEVRON;
      t.setAttribute("aria-label", this.fold === "folded" ? "Expand" : "Collapse");
      t.tabIndex = -1;
    }
    if (this.grip) {
      const g = box.appendChild(document.createElement("button"));
      g.className = "cm-grip";
      g.innerHTML = GRIP;
      g.setAttribute("aria-label", "Drag to move, click for options");
      g.title = "Drag to move · click for options";
      g.tabIndex = -1;
    }
    return box;
  }
}

/** Headings and list items with something under them fold; anything already folded can unfold. */
function foldState(state: EditorState, from: number, to: number): "none" | "open" | "folded" {
  let folded = false;
  foldedRanges(state).between(to, to + 1, (a) => {
    if (a === to) folded = true;
  });
  if (folded) return "folded";
  const text = state.doc.sliceString(from, to);
  if (!/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(text)) return "none";
  return foldable(state, from, to) ? "open" : "none";
}

function toggleFold(view: EditorView, from: number, to: number) {
  const { state } = view;
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(state).between(to, to + 1, (a, b) => {
    if (a === to) effects.push(unfoldEffect.of({ from: a, to: b }));
  });
  if (!effects.length) {
    const r = foldable(state, from, to);
    if (r) effects.push(foldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
}

/** The cursor block's menu, from the keyboard: anchored to its grip. */
const openMenu =
  (handlers: HandleHandlers): Command =>
  (view) => {
    const blocks = blocksOf(view.state);
    const i = blockAt(blocks, view.state.selection.main.head);
    if (i < 0) return false;
    if (view.state.field(hoverField) >= 0) view.dispatch({ effects: setHover.of(-1) });
    const grip = view.dom.querySelector<HTMLElement>(".cm-handles .cm-grip");
    const anchor = grip ?? (view.domAtPos(blocks[i].from).node.parentElement as HTMLElement);
    handlers.menu(anchor, actions(view, blocks, i));
    return true;
  };

const moveBy =
  (delta: -1 | 1): Command =>
  (view) => {
    const blocks = blocksOf(view.state);
    const i = blockAt(blocks, view.state.selection.main.head);
    if (i < 0 || i + delta < 0 || i + delta >= blocks.length) return false;
    moveTo(view, blocks, i, delta < 0 ? i - 1 : i + 2);
    return true;
  };

export function blockHandles(handlers: HandleHandlers) {
  const handles = gutter({
    class: "cm-handles",
    lineMarker(view, line) {
      const shown = shownBlock(view) === line.from;
      const fold = foldState(view.state, line.from, view.state.doc.lineAt(line.from).to);
      if (!shown && fold !== "folded") return null;
      return new HandleMarker(shown, fold);
    },
    lineMarkerChange: (u) =>
      u.docChanged ||
      u.selectionSet ||
      u.focusChanged ||
      u.startState.field(hoverField) !== u.state.field(hoverField) ||
      foldedRanges(u.startState) !== foldedRanges(u.state),
    domEventHandlers: {
      pointerdown(view, line, e) {
        const ev = e as PointerEvent;
        const target = ev.target as HTMLElement;
        if (ev.button !== 0) return false;
        if (target.closest(".cm-fold-toggle")) {
          ev.preventDefault();
          toggleFold(view, line.from, view.state.doc.lineAt(line.from).to);
          return true;
        }
        const grip = target.closest<HTMLElement>(".cm-grip");
        if (!grip) return false;
        ev.preventDefault();
        startDrag(view, grip, line.from, ev, handlers);
        return true;
      },
    },
  });

  // Track the block under the pointer.
  const hover = ViewPlugin.define((view) => {
    let dragging = false;
    const move = (e: MouseEvent) => {
      if (dragging || e.buttons) return;
      const { blocks, i } = blockUnder(view, e.clientY);
      const at = i < 0 ? -1 : blocks[i].from;
      if (at !== view.state.field(hoverField)) view.dispatch({ effects: setHover.of(at) });
    };
    const leave = () => view.state.field(hoverField) >= 0 && view.dispatch({ effects: setHover.of(-1) });
    const lock = (e: Event) => (dragging = (e as CustomEvent<boolean>).detail);
    view.dom.addEventListener("mousemove", move);
    view.dom.addEventListener("mouseleave", leave);
    view.dom.addEventListener("cm-block-drag", lock);
    return {
      destroy() {
        view.dom.removeEventListener("mousemove", move);
        view.dom.removeEventListener("mouseleave", leave);
        view.dom.removeEventListener("cm-block-drag", lock);
      },
    };
  });

  const keys = Prec.high(
    keymap.of([
      { key: "Mod-/", run: openMenu(handlers) },
      { key: "Mod-Shift-ArrowUp", run: moveBy(-1) },
      { key: "Mod-Shift-ArrowDown", run: moveBy(1) },
    ]),
  );

  return [hoverField, dragField, handles, hover, keys];
}

/** Where a block let go at `y` lands: before the block at the returned index (`blocks.length` for the end). */
function dropAt(view: EditorView, y: number): { blocks: Block[]; dest: number; bottom: number } | null {
  const { blocks, i } = blockUnder(view, y);
  if (i < 0) return null;
  const b = blocks[i];
  const top = view.lineBlockAt(b.from).top;
  const bottom = view.lineBlockAt(b.to).bottom;
  return { blocks, dest: y - view.documentTop < (top + bottom) / 2 ? i : i + 1, bottom };
}

/**
 * A press on a grip: a click opens the menu, a drag moves the block to where it's let go.
 * The text can change during a drag (a change syncing in), so the block is followed by its
 * position, mapped through each change, and the blocks are read afresh when it's let go.
 */
function startDrag(view: EditorView, grip: HTMLElement, from: number, down: PointerEvent, handlers: HandleHandlers) {
  const start = blocksOf(view.state);
  const at = blockAt(start, from);
  if (at < 0) return;
  view.dispatch({ effects: setDrag.of(start[at].from) });
  let dragging = false;
  let lastY = down.clientY;
  const line = document.createElement("div");
  line.className = "cm-drop-line";

  /** The dragged block in the text as it is now, or -1 if it has gone. */
  const current = (blocks: Block[]) => {
    const pos = view.state.field(dragField);
    return pos === null ? -1 : blocks.findIndex((b) => b.from === pos);
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(e.clientY - down.clientY) < 4) return;
      dragging = true;
      view.dom.dispatchEvent(new CustomEvent("cm-block-drag", { detail: true }));
      view.dom.classList.add("cm-dragging-block");
      view.dom.appendChild(line);
    }
    lastY = e.clientY;
    const drop = dropAt(view, e.clientY);
    if (!drop) return;
    const { blocks, dest, bottom } = drop;
    const i = current(blocks);
    const y = dest < blocks.length ? view.lineBlockAt(blocks[dest].from).top : bottom;
    const offset = view.documentTop - view.dom.getBoundingClientRect().top;
    line.style.top = `${offset + y - 1}px`;
    line.style.display = i < 0 || dest === i || dest === i + 1 ? "none" : "";
  };
  const onUp = (cancelled = false) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", onCancel);
    line.remove();
    view.dom.classList.remove("cm-dragging-block");
    view.dom.dispatchEvent(new CustomEvent("cm-block-drag", { detail: false }));
    const blocks = blocksOf(view.state);
    const i = current(blocks);
    view.dispatch({ effects: setDrag.of(null) });
    // The block was deleted while held: nothing to move, and no menu for it.
    if (i < 0 || cancelled) return;
    if (!dragging) return handlers.menu(grip, actions(view, blocks, i));
    const drop = dropAt(view, lastY);
    if (!drop) return;
    moveTo(view, drop.blocks, i, drop.dest);
    view.focus();
  };
  const up = () => onUp();
  const onCancel = () => onUp(true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", onCancel);
}
