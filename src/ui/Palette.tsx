import {
  Coffee,
  CornerDownLeft,
  FileText,
  FolderOpen,
  GitBranch,
  Keyboard,
  Moon,
  NotebookPen,
  Plus,
  Search,
  Sun,
  Sunrise,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { itemHref, TYPE_LABELS } from "../capture/capture";
import { folderCtx, visibleFolders } from "../folders/registry";
import type { Folder, ItemType } from "../model";
import { dailyNote, openOrCreate } from "../notes/notes";
import { escapeTitle, sameTitle } from "../notes/links";
import { closePalette, lastFolder, navigate, openQuickAdd, openShortcuts, setTheme, useUI } from "../store/ui";

/*
 * Ctrl+K (or Cmd+K) from anywhere: type to jump to any item in any folder by its title, or to run
 * one of the commands listed below (go to a place, save, search, the shortcuts, the theme). It
 * doesn't reach actions on an item, such as archiving or renaming: those are on the item's menu
 * and its keys (see Shortcuts.tsx).
 */

interface ItemRow {
  folder: string;
  folderName: string;
  id: string;
  type: ItemType;
  title: string;
  updatedAt: number;
}

interface Choice {
  key: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  /** A shortcut that does the same from anywhere. */
  keys?: string;
  run: () => void | Promise<void>;
}

export function Palette() {
  const open = useUI((s) => s.palette);
  return open ? <PaletteDialog /> : null;
}

/**
 * How well `text` matches what was typed: higher is better, -1 is no match.
 * A run of the typed letters beats scattered ones, and earlier and at a word start beats later.
 */
export function matchScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at + (at === 0 || /\W/.test(t[at - 1]) ? 200 : 0) + (t.length === q.length ? 500 : 0);
  // Every typed letter in order, with gaps allowed.
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const next = t.indexOf(ch, i);
    if (next < 0) return -1;
    if (next > i) gaps++;
    i = next + 1;
  }
  return 500 - gaps * 20 - i;
}

/** The folder new things go into: the one on screen, else the last used, else the first. */
function targetFolder(folders: Folder[]): Folder | undefined {
  const r = useUI.getState().route;
  const onScreen = r.name === "library" || r.name === "item" || r.name === "reader" ? r.folder : undefined;
  return folders.find((f) => f.id === onScreen) ?? folders.find((f) => f.id === lastFolder()) ?? folders[0];
}

function PaletteDialog() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const theme = useUI((s) => s.theme);
  const themeChosen = useUI((s) => s.themeChosen);

  // Closing without going anywhere puts you back where you were typing.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    return () => {
      setTimeout(() => {
        if (before?.isConnected && (!document.activeElement || document.activeElement === document.body)) before.focus();
      }, 0);
    };
  }, [before]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const fs = await visibleFolders();
      const rows: ItemRow[] = [];
      for (const f of fs) {
        // Only what the list shows is kept, not each item's whole text.
        await folderCtx(f.id).db.items.each((i) => {
          if (i.deleted) return;
          rows.push({ folder: f.id, folderName: f.name, id: i.id, type: i.type, title: i.title || "Untitled", updatedAt: i.updatedAt });
        });
      }
      if (!live) return;
      setFolders(fs);
      setItems(rows);
    })();
    return () => {
      live = false;
    };
  }, []);

  const choices = useMemo<Choice[]>(() => {
    const q = query.trim();
    const many = folders.length > 1;
    const into = targetFolder(folders);

    const commands: Choice[] = [
      {
        key: "today",
        icon: <Sunrise size={16} />,
        label: "Go to Today",
        run: () => navigate({ name: "today" }),
      },
      {
        key: "daily",
        icon: <NotebookPen size={16} />,
        label: "Open today's note",
        run: async () => {
          if (!into) return;
          const note = await dailyNote(into.id);
          navigate({ name: "item", folder: into.id, item: note.id });
        },
      },
      {
        key: "save",
        icon: <Plus size={16} />,
        label: "Save something new",
        keys: "N",
        run: () => openQuickAdd(into ? { folder: into.id } : {}),
      },
      {
        key: "search",
        icon: <Search size={16} />,
        label: "Search everything",
        keys: "/",
        run: () => navigate({ name: "search" }),
      },
      ...folders.map((f) => ({
        key: `folder:${f.id}`,
        icon: <FolderOpen size={16} />,
        label: `Go to ${f.name}`,
        run: () => navigate({ name: "library" as const, folder: f.id }),
      })),
      {
        key: "shortcuts",
        icon: <Keyboard size={16} />,
        label: "Keyboard shortcuts",
        keys: "?",
        run: openShortcuts,
      },
      {
        key: "github",
        icon: <GitBranch size={16} />,
        label: "GitHub and sync settings",
        run: () => navigate({ name: "setup" }),
      },
      ...(["light", "sepia", "dark"] as const)
        .filter((t) => t !== theme)
        .map((t) => ({
          key: `theme:${t}`,
          icon: t === "light" ? <Sun size={16} /> : t === "sepia" ? <Coffee size={16} /> : <Moon size={16} />,
          label: `Use the ${t} theme`,
          run: () => setTheme(t),
        })),
      ...(themeChosen
        ? [{ key: "theme:device", icon: <Moon size={16} />, label: "Match the device's light or dark setting", run: () => setTheme(null) }]
        : []),
    ];

    const itemChoice = (r: ItemRow): Choice => ({
      key: `item:${r.folder}:${r.id}`,
      icon: <FileText size={16} />,
      label: r.title,
      hint: many ? `${TYPE_LABELS[r.type]} · ${r.folderName}` : TYPE_LABELS[r.type],
      run: () => {
        location.hash = itemHref(r.folder, r);
      },
    });

    if (!q) {
      const recent = [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
      return [...recent.map(itemChoice), ...commands];
    }

    const ranked = <T,>(xs: T[], text: (x: T) => string) =>
      xs
        .map((x) => ({ x, s: matchScore(text(x), q) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((r) => r.x);

    const out = [
      ...ranked(items, (r) => r.title)
        .slice(0, 8)
        .map(itemChoice),
      ...ranked(commands, (c) => c.label),
    ];
    // A title nothing has yet can become a note, the same way a [[link]] to it would.
    if (into && !/[[\]|#\n]/.test(q) && !items.some((r) => r.folder === into.id && sameTitle(r.title, q))) {
      out.push({
        key: "new",
        icon: <Plus size={16} />,
        label: `New note “${q}”`,
        hint: many ? into.name : undefined,
        run: async () => {
          // Asked for by name, so no second question; escaped, so a # or | in it is part of the title.
          const note = await openOrCreate(into.id, escapeTitle(q), false);
          if (note) navigate({ name: "item", folder: into.id, item: note.id });
        },
      });
    }
    out.push({
      key: "find",
      icon: <Search size={16} />,
      label: `Search everything for “${q}”`,
      run: () => navigate({ name: "search", q }),
    });
    return out;
  }, [query, items, folders, theme, themeChosen]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (c: Choice | undefined) => {
    if (!c) return;
    closePalette();
    void c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(choices.length, 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive((a) => (a - 1 + choices.length) % Math.max(choices.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(choices[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    } else if (e.key === "Tab") {
      // The list is reached with the arrow keys; Tab stays in the box rather than leaving the dialog.
      e.preventDefault();
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Go to anything">
        <div className="palette-input">
          <Search size={18} className="muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Go to an item by title, or type a command"
            aria-label="Go to anything"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={choices[active] ? `palette-${active}` : undefined}
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {choices.map((c, i) => (
            <div
              key={c.key}
              id={`palette-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={`palette-row ${i === active ? "active" : ""}`}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => choose(c)}
            >
              <span className="palette-icon">{c.icon}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
              {c.keys && <kbd>{c.keys}</kbd>}
              {i === active && <CornerDownLeft size={14} className="muted" />}
            </div>
          ))}
          {!choices.length && <p className="palette-empty muted">Nothing matches.</p>}
        </div>
      </div>
    </div>
  );
}
