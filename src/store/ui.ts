import { create } from "zustand";

export type Theme = "light" | "sepia" | "dark";

export type Route =
  | { name: "library"; folder?: string }
  | { name: "reader"; folder: string; doc: string; page?: number; find?: string; panel?: "notes" }
  | { name: "item"; folder: string; item: string }
  | { name: "graph"; folder: string }
  | { name: "save" }
  | { name: "search"; q?: string }
  | { name: "highlights" }
  | { name: "setup" }
  | { name: "today" }
  | { name: "welcome" };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  ttl?: number;
}

/** What the quick-add box opens with: pasted or shared text, and the folder to save into. */
export interface QuickAddPrefill {
  text?: string;
  title?: string;
  folder?: string;
  /** A passage from the page a link came from: kept with the link as a quote. */
  quote?: string;
}

interface UIState {
  route: Route;
  theme: Theme;
  /** False while the theme follows the device's dark-mode setting, before you pick one. */
  themeChosen: boolean;
  toasts: Toast[];
  quickAdd: QuickAddPrefill | null;
  palette: boolean;
  shortcuts: boolean;
  /** A paragraph an answer cites, waiting for its item's article view to scroll to it. */
  paragraphJump: ParagraphJump | null;
}

/** A paragraph to show: its number, and its text when the answer was given, to find it if the article moved. */
export interface ParagraphJump {
  item: string;
  n: number;
  quote: string;
}

const ID = "[A-Za-z0-9-]+";

function parseHash(): Route {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?", 2);
  const q = new URLSearchParams(query);
  let m = new RegExp(`^/f/(${ID})/doc/([0-9a-f]{64})$`).exec(path);
  if (m)
    return {
      name: "reader",
      folder: m[1],
      doc: m[2],
      page: Number(q.get("page")) || undefined,
      find: q.get("find") ?? undefined,
      panel: q.get("panel") === "notes" ? "notes" : undefined,
    };
  m = new RegExp(`^/f/(${ID})/item/(${ID})$`).exec(path);
  if (m) return { name: "item", folder: m[1], item: m[2] };
  m = new RegExp(`^/f/(${ID})/graph$`).exec(path);
  if (m) return { name: "graph", folder: m[1] };
  m = new RegExp(`^/f/(${ID})$`).exec(path);
  if (m) return { name: "library", folder: m[1] };
  if (path === "/search") return { name: "search", q: q.get("q") ?? undefined };
  if (path === "/setup") return { name: "setup" };
  if (path === "/highlights") return { name: "highlights" };
  if (path === "/library") return { name: "library" };
  if (path === "/welcome") return { name: "welcome" };
  if (path === "/save") return { name: "save" };
  return { name: "today" };
}

export function routeHash(route: Route): string {
  const q = new URLSearchParams();
  switch (route.name) {
    case "library":
      return route.folder ? `#/f/${route.folder}` : "#/library";
    case "reader":
      if (route.page) q.set("page", String(route.page));
      if (route.find) q.set("find", route.find);
      if (route.panel) q.set("panel", route.panel);
      return `#/f/${route.folder}/doc/${route.doc}${q.size ? `?${q}` : ""}`;
    case "item":
      return `#/f/${route.folder}/item/${route.item}`;
    case "graph":
      return `#/f/${route.folder}/graph`;
    case "save":
      return "#/save";
    case "search":
      if (route.q) q.set("q", route.q);
      return `#/search${q.size ? `?${q}` : ""}`;
    case "setup":
      return "#/setup";
    case "highlights":
      return "#/highlights";
    case "today":
      return "#/today";
    case "welcome":
      return "#/welcome";
  }
}

const THEMES: Theme[] = ["light", "sepia", "dark"];
const chosenTheme = () => {
  const t = localStorage.getItem("reader.theme") as Theme | null;
  return t && THEMES.includes(t) ? t : null;
};
const darkMode = window.matchMedia?.("(prefers-color-scheme: dark)");
const deviceTheme = (): Theme => (darkMode?.matches ? "dark" : "light");

export const useUI = create<UIState>(() => ({
  route: parseHash(),
  theme: chosenTheme() ?? deviceTheme(),
  themeChosen: chosenTheme() !== null,
  toasts: [],
  quickAdd: null,
  palette: false,
  shortcuts: false,
  paragraphJump: null,
}));

/** Ask the open item's article view to show a paragraph. */
export function jumpToParagraph(item: string, n: number, quote: string): void {
  useUI.setState({ paragraphJump: { item, n, quote } });
}
export function clearParagraphJump(): void {
  useUI.setState({ paragraphJump: null });
}

export const openPalette = () => useUI.setState({ palette: true });
export const closePalette = () => useUI.setState({ palette: false });
export const openShortcuts = () => useUI.setState({ shortcuts: true, palette: false });
export const closeShortcuts = () => useUI.setState({ shortcuts: false });

export function openQuickAdd(prefill: QuickAddPrefill = {}) {
  useUI.setState({ quickAdd: prefill });
}
export function closeQuickAdd() {
  useUI.setState({ quickAdd: null });
}

window.addEventListener("hashchange", () => useUI.setState({ route: parseHash() }));

/** `replace` updates the address without adding a history entry (used for live search text). */
export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const hash = routeHash(route);
  if (opts.replace) {
    history.replaceState(null, "", hash);
    useUI.setState({ route: parseHash() });
  } else location.hash = hash;
}

/** The folder last opened, so the app returns to it. */
export function lastFolder(): string | null {
  return localStorage.getItem("reader.folder");
}
export function rememberFolder(id: string) {
  localStorage.setItem("reader.folder", id);
}

/** Pick a theme, or pass null to follow the device's dark-mode setting again. */
export function setTheme(theme: Theme | null) {
  if (theme) localStorage.setItem("reader.theme", theme);
  else localStorage.removeItem("reader.theme");
  useUI.setState({ theme: theme ?? deviceTheme(), themeChosen: theme !== null });
}

// Until you pick a theme, it follows the device as it switches between light and dark.
darkMode?.addEventListener?.("change", () => {
  if (!useUI.getState().themeChosen) useUI.setState({ theme: deviceTheme() });
});

let toastId = 0;
export function toast(text: string, opts: Omit<Toast, "id" | "text"> = {}) {
  const t: Toast = { id: ++toastId, text, ...opts };
  useUI.setState((s) => ({ toasts: [...s.toasts.filter((x) => x.text !== text), t] }));
  const ttl = opts.ttl ?? (opts.action ? 9000 : 3500);
  if (ttl > 0) setTimeout(() => dismissToast(t.id), ttl);
  return t.id;
}

export function dismissToast(id: number) {
  useUI.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
