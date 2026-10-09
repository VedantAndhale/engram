import { create } from "zustand";

export type Theme = "light" | "sepia" | "dark";

export type Route =
  | { name: "library"; folder?: string }
  | { name: "reader"; folder: string; doc: string; page?: number; find?: string }
  | { name: "search"; q?: string }
  | { name: "setup" };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  ttl?: number;
}

interface UIState {
  route: Route;
  theme: Theme;
  toasts: Toast[];
}

const ID = "[A-Za-z0-9-]+";

function parseHash(): Route {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?", 2);
  const q = new URLSearchParams(query);
  let m = new RegExp(`^/f/(${ID})/doc/([0-9a-f]{64})$`).exec(path);
  if (m) return { name: "reader", folder: m[1], doc: m[2], page: Number(q.get("page")) || undefined, find: q.get("find") ?? undefined };
  m = new RegExp(`^/f/(${ID})$`).exec(path);
  if (m) return { name: "library", folder: m[1] };
  if (path === "/search") return { name: "search", q: q.get("q") ?? undefined };
  if (path === "/setup") return { name: "setup" };
  return { name: "library" };
}

export function routeHash(route: Route): string {
  const q = new URLSearchParams();
  switch (route.name) {
    case "library":
      return route.folder ? `#/f/${route.folder}` : "#/";
    case "reader":
      if (route.page) q.set("page", String(route.page));
      if (route.find) q.set("find", route.find);
      return `#/f/${route.folder}/doc/${route.doc}${q.size ? `?${q}` : ""}`;
    case "search":
      if (route.q) q.set("q", route.q);
      return `#/search${q.size ? `?${q}` : ""}`;
    case "setup":
      return "#/setup";
  }
}

export const useUI = create<UIState>(() => ({
  route: parseHash(),
  theme: (localStorage.getItem("reader.theme") as Theme) ?? "light",
  toasts: [],
}));

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

export function setTheme(theme: Theme) {
  localStorage.setItem("reader.theme", theme);
  useUI.setState({ theme });
}

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
