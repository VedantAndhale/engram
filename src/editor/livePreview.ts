import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

/*
 * Live preview, the Obsidian model: the file stays plain Markdown, but lines you aren't editing
 * show formatted. Markup (#, **, [](), [[ ]]) is hidden everywhere except on the lines the
 * cursor or selection touches, so editing always happens on the real text.
 */

export const WIKI_LINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

class BulletWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
  eq() {
    return true;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Done" : "To do");
    return box;
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  ignoreEvent() {
    return false;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });

/** Line numbers the selection touches: those show their raw Markdown. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out;
}

function build(view: EditorView, focused: boolean): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // While the editor isn't focused every line previews, so a note at rest reads cleanly.
  const active = focused ? activeLines(state) : new Set<number>();
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];
  const codeRanges: [number, number][] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const raw = isActive(node.from);

        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          decos.push(line(`cm-h cm-h${heading[1]}`).range(doc.lineAt(node.from).from));
          return;
        }
        switch (name) {
          case "HeaderMark": {
            if (raw || doc.lineAt(node.from).from !== node.from) return; // keep Setext underlines and closing #s simple
            const next = doc.sliceString(node.to, node.to + 1);
            decos.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
            return;
          }
          case "StrongEmphasis":
            decos.push(mark("cm-strong").range(node.from, node.to));
            return;
          case "Emphasis":
            decos.push(mark("cm-em").range(node.from, node.to));
            return;
          case "Strikethrough":
            decos.push(mark("cm-strike").range(node.from, node.to));
            return;
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!raw) decos.push(hide.range(node.from, node.to));
            return;
          case "InlineCode":
            decos.push(mark("cm-inline-code").range(node.from, node.to));
            return;
          case "CodeMark":
            if (node.node.parent?.name === "InlineCode" && !raw) decos.push(hide.range(node.from, node.to));
            return;
          case "FencedCode": {
            codeRanges.push([node.from, node.to]);
            for (let pos = node.from; pos <= node.to; ) {
              const l = doc.lineAt(pos);
              decos.push(line("cm-codeblock").range(l.from));
              pos = l.to + 1;
            }
            return false;
          }
          case "Blockquote": {
            for (let pos = node.from; pos <= node.to; ) {
              const l = doc.lineAt(pos);
              decos.push(line("cm-quote").range(l.from));
              pos = l.to + 1;
            }
            return;
          }
          case "QuoteMark": {
            if (raw) return;
            const next = doc.sliceString(node.to, node.to + 1);
            decos.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
            return;
          }
          case "HorizontalRule":
            decos.push(line("cm-hr-line").range(doc.lineAt(node.from).from));
            if (!raw) decos.push(hide.range(node.from, node.to));
            return;
          case "ListMark": {
            const item = node.node.parent;
            const isTask = !!item?.getChild("Task");
            const inBullets = item?.parent?.name === "BulletList";
            if (raw) return;
            if (isTask) {
              const next = doc.sliceString(node.to, node.to + 1);
              decos.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
            } else if (inBullets) decos.push(bullet.range(node.from, node.to));
            return;
          }
          case "TaskMarker": {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to));
            if (checked) {
              const l = doc.lineAt(node.from);
              if (node.to + 1 < l.to) decos.push(mark("cm-task-done").range(node.to + 1, l.to));
            }
            return;
          }
          case "Link": {
            const marks = node.node.getChildren("LinkMark");
            const url = node.node.getChild("URL");
            // Without a URL it's a bare [text] (Markdown reads the inside of [[a link]] that way): leave it.
            if (marks.length < 2 || !url) return;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            const href = url ? doc.sliceString(url.from, url.to) : "";
            if (raw) {
              decos.push(mark("cm-link-raw").range(node.from, node.to));
              return;
            }
            if (textTo > textFrom) decos.push(mark("cm-link", { "data-href": href }).range(textFrom, textTo));
            decos.push(hide.range(node.from, textFrom));
            decos.push(hide.range(textTo, node.to));
            return false;
          }
          case "URL":
            if (node.node.parent?.name !== "Link") {
              decos.push(mark("cm-link", { "data-href": doc.sliceString(node.from, node.to) }).range(node.from, node.to));
            }
            return;
        }
      },
    });

    // [[Wiki links]] aren't part of Markdown's grammar, so they are found by pattern.
    const text = doc.sliceString(from, to);
    for (const m of text.matchAll(WIKI_LINK)) {
      const start = from + m.index!;
      const end = start + m[0].length;
      if (codeRanges.some(([a, b]) => start >= a && start < b)) continue;
      const inCode = syntaxTree(state).resolveInner(start + 2, 1).name;
      if (inCode === "InlineCode" || inCode === "CodeText") continue;
      const target = m[1].trim();
      if (isActive(start)) {
        decos.push(mark("cm-wikilink cm-wikilink-raw", { "data-wiki": target }).range(start, end));
        continue;
      }
      const shownFrom = m[2] ? start + 2 + m[1].length + 1 : start + 2;
      decos.push(hide.range(start, shownFrom));
      decos.push(mark("cm-wikilink", { "data-wiki": target }).range(shownFrom, end - 2));
      decos.push(hide.range(end - 2, end));
    }
  }
  return Decoration.set(decos, true);
}

export interface LinkHandlers {
  /** Open the item a [[link]] names (creating it if there isn't one). */
  openWiki: (title: string) => void;
}

export function livePreview(handlers: LinkHandlers) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, view.hasFocus);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view, u.view.hasFocus);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const target = e.target as HTMLElement;

      // Tick a task: swap "[ ]" and "[x]" in the text itself.
      if (target.classList.contains("cm-task-box")) {
        const pos = view.posAtDOM(target);
        const cur = view.state.doc.sliceString(pos, pos + 3);
        if (/^\[[ xX]\]$/.test(cur)) {
          view.dispatch({ changes: { from: pos, to: pos + 3, insert: cur[1] === " " ? "[x]" : "[ ]" } });
          e.preventDefault();
          return true;
        }
        return false;
      }

      // Links open on a plain click where they show formatted, or Ctrl/Cmd+click while editing them.
      const el = target.closest<HTMLElement>("[data-wiki]") ?? target.closest<HTMLElement>("[data-href]");
      if (!el || e.button !== 0) return false;
      const formatted = !el.classList.contains("cm-wikilink-raw") && !el.closest(".cm-link-raw");
      if (!formatted && !(e.ctrlKey || e.metaKey)) return false;
      e.preventDefault();
      if (el.dataset.wiki) handlers.openWiki(el.dataset.wiki);
      else if (el.dataset.href && /^https?:\/\//i.test(el.dataset.href)) window.open(el.dataset.href, "_blank", "noopener,noreferrer");
      return true;
    },
  });

  return [plugin, clicks];
}
