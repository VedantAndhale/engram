// The app's screens and their addresses. Pure: no window, no history, so the tests can run it in Node.
// Addresses are clean paths (/today, /f/<folder>/item/<id>). Before that they were hash routes (#/today);
// legacyHashPath() turns those into paths so old links, bookmarklets and agent-made links still open.

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

const ID = "[A-Za-z0-9-]+";

/** A screen from a path (after the app's base, starting with "/") and its query string. */
export function parseRoute(path: string, search = ""): Route {
  const q = new URLSearchParams(search);
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
  // The page was /setup; that address still opens it, and the app moves it to /settings.
  if (path === "/settings" || path === "/setup") return { name: "setup" };
  if (path === "/highlights") return { name: "highlights" };
  if (path === "/library") return { name: "library" };
  if (path === "/welcome") return { name: "welcome" };
  if (path === "/save") return { name: "save" };
  return { name: "today" };
}

/** The address of a screen: the app's base (no trailing slash, "" at a domain root), then the path and query. */
export function routeHref(route: Route, base = ""): string {
  const q = new URLSearchParams();
  let path: string;
  switch (route.name) {
    case "library":
      path = route.folder ? `/f/${route.folder}` : "/library";
      break;
    case "reader":
      if (route.page) q.set("page", String(route.page));
      if (route.find) q.set("find", route.find);
      if (route.panel) q.set("panel", route.panel);
      path = `/f/${route.folder}/doc/${route.doc}`;
      break;
    case "item":
      path = `/f/${route.folder}/item/${route.item}`;
      break;
    case "graph":
      path = `/f/${route.folder}/graph`;
      break;
    case "save":
      path = "/save";
      break;
    case "search":
      if (route.q) q.set("q", route.q);
      path = "/search";
      break;
    case "setup":
      path = "/settings";
      break;
    case "highlights":
      path = "/highlights";
      break;
    case "today":
      path = "/today";
      break;
    case "welcome":
      path = "/welcome";
      break;
  }
  return `${base}${path}${q.size ? `?${q}` : ""}`;
}

/** The path a legacy hash address (#/today, #/save?url=…) names, or null if the hash is not one. */
export function legacyHashPath(hash: string): string | null {
  return hash.startsWith("#/") ? hash.slice(1) : null;
}

/** Whether a path is one of the app's screens. Links to anything else are left to the browser. */
export function isAppPath(path: string): boolean {
  return /^\/(today|library|save|search|settings|setup|highlights|welcome)(\/|$)/.test(path) || /^\/f\/[A-Za-z0-9-]+(\/|$)/.test(path);
}
