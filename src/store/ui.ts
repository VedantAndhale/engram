import { create } from "zustand";
import { isAppPath, legacyHashPath, parseRoute, routeHref, type Route } from "./route";
import { APP_BASE } from "../lib/base";

export type Theme = "light" | "sepia" | "dark";

export type { Route } from "./route";

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

const THEMES: Theme[] = ["light", "sepia", "dark"];
const chosenTheme = () => {
  const t = localStorage.getItem("reader.theme") as Theme | null;
  return t && THEMES.includes(t) ? t : null;
};
const darkMode = window.matchMedia?.("(prefers-color-scheme: dark)");
const deviceTheme = (): Theme => (darkMode?.matches ? "dark" : "light");

/** The screen the address shows. The app lives under APP_BASE, so that part is not a route. */
function currentRoute(): Route {
  const path = location.pathname.startsWith(APP_BASE) ? location.pathname.slice(APP_BASE.length) : location.pathname;
  return parseRoute(path || "/", location.search);
}

/** A hash address from before clean paths (#/save?url=...) moves to its path, so old links still open. */
function adoptLegacyHash() {
  const path = legacyHashPath(location.hash);
  if (path !== null) history.replaceState(null, "", APP_BASE + path);
}

adoptLegacyHash();

// The Settings page used to live at /setup. That address still opens it, but the address bar moves to /settings.
function adoptOldSettingsPath() {
  if (location.pathname === `${APP_BASE}/setup`) history.replaceState(null, "", `${APP_BASE}/settings${location.search}${location.hash}`);
}
adoptOldSettingsPath();

export const useUI = create<UIState>(() => ({
  route: currentRoute(),
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

/** Back and forward, and a hash address typed or pasted in, change the screen. */
function syncRoute() {
  adoptLegacyHash();
  adoptOldSettingsPath();
  useUI.setState({ route: currentRoute() });
}
window.addEventListener("popstate", syncRoute);
window.addEventListener("hashchange", syncRoute);

// Following a link to one of the app's screens changes the screen without a reload.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null | undefined;
  if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin || a.hash) return;
  const path = a.pathname.startsWith(APP_BASE) ? a.pathname.slice(APP_BASE.length) : a.pathname;
  if (!isAppPath(path)) return;
  e.preventDefault();
  go(a.pathname + a.search);
});

/** `replace` updates the address without adding a history entry (used for live search text). */
export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const href = routeHref(route, APP_BASE);
  if (!opts.replace) return go(href);
  history.replaceState(null, "", href);
  useUI.setState({ route: currentRoute() });
}

/** Open an address the app built (an item, a folder): the same as following a link to it. */
export function go(href: string) {
  const url = new URL(href, location.origin);
  const next = url.pathname + url.search;
  if (next !== location.pathname + location.search) history.pushState(null, "", next);
  useUI.setState({ route: currentRoute() });
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
