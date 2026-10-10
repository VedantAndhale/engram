import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useEffect, useState } from "react";
import { folderCtx, visibleFolders } from "../folders/registry";
import { setHabit, useHabit } from "../habit/prefs";
import { findUrl } from "../capture/capture";
import { closePalette, lastFolder, navigate, openPalette, openQuickAdd, openShortcuts, useUI } from "../store/ui";
import { QuickAdd, SavePage } from "./Capture";
import { Toasts } from "./common";
import { ItemView } from "./ItemView";
import { Library } from "./Library";
import { Palette } from "./Palette";
import { Search } from "./Search";
import { Setup } from "./Setup";
import { Shortcuts } from "./Shortcuts";
import { Sidebar } from "./Sidebar";
import { Today } from "./Today";
import { Welcome } from "./Welcome";

// The reader pulls in pdf.js's viewer pieces; load it only when a document is opened.
const Reader = lazy(() => import("./reader/Reader").then((m) => ({ default: m.Reader })));

export function App() {
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const folders = useLiveQuery(visibleFolders, []);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  }, [theme]);

  // Ctrl+K (Cmd+K on a Mac) opens the palette from anywhere, text fields and the editor included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const { route, palette } = useUI.getState();
      if (route.name === "save" || route.name === "welcome") return;
      e.preventDefault();
      if (palette) closePalette();
      else openPalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // "?" lists every shortcut; J and K step through the cards or results on screen (Enter opens one).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
      const { route, palette, quickAdd } = useUI.getState();
      if (route.name === "save" || route.name === "welcome" || palette || quickAdd) return;
      if (e.key === "?") {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if ((e.key !== "j" && e.key !== "k") || route.name === "reader" || document.querySelector(".modal")) return;
      const all = [...document.querySelectorAll<HTMLElement>("main .doc-card, main .result")];
      if (!all.length) return;
      e.preventDefault();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (e.key === "j" ? 0 : all.length - 1) : Math.min(Math.max(at + (e.key === "j" ? 1 : -1), 0), all.length - 1);
      all[next].focus();
      all[next].scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "/" jumps to search from anywhere except text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t.closest("input, textarea, [contenteditable]")) return;
      if (useUI.getState().route.name === "reader") return; // the reader uses "/" for find-in-document
      e.preventDefault();
      navigate({ name: "search" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Saving is always one key or one paste away: "n" opens the save box, and pasting anywhere
  // outside a text field opens it with what you pasted.
  useEffect(() => {
    const away = () => {
      const { route, quickAdd } = useUI.getState();
      return !quickAdd && route.name !== "reader" && route.name !== "save" && route.name !== "welcome" && !document.querySelector(".modal");
    };
    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || !away()) return;
      e.preventDefault();
      openQuickAdd(folderOnScreen());
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain").trim();
      if (!text || typing(e.target) || !away()) return;
      e.preventDefault();
      openQuickAdd({ text, ...folderOnScreen() });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  // Shared from another app (Android share sheet): the installed app opens with ?title&text&url.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!q.has("text") && !q.has("url") && !q.has("title")) return;
    const text = q.get("text") ?? "";
    const url = q.get("url") || findUrl(text);
    const rest = url ? text.replace(url, "").trim() : text.trim();
    history.replaceState(null, "", location.pathname + location.hash); // don't keep it in the address
    openQuickAdd(url ? { text: url, title: q.get("title") || rest || undefined } : { text: [q.get("title"), rest].filter(Boolean).join("\n\n") });
  }, []);

  useEffect(() => setDrawer(false), [route]);

  // First run goes through the welcome flow. Anyone who already has documents has clearly started.
  const welcomed = useHabit((s) => s.welcomed);
  useEffect(() => {
    if (welcomed || !folders) return;
    // Saving from the bookmark or the share sheet comes first; welcome can wait.
    if (useUI.getState().route.name === "save" || useUI.getState().quickAdd) return;
    void (async () => {
      for (const f of folders) {
        if (await folderCtx(f.id).db.items.filter((d) => !d.deleted).count()) return setHabit({ welcomed: true });
      }
      navigate({ name: "welcome" }, { replace: true });
    })();
  }, [welcomed, folders]);

  if (!folders) return null;

  if (route.name === "save") {
    return (
      <>
        <SavePage />
        <Toasts />
      </>
    );
  }

  if (route.name === "welcome") {
    return (
      <>
        <Welcome />
        <Toasts />
      </>
    );
  }

  // Which folder is on screen: the one in the address, else the last one used, else the first.
  const wanted = route.name === "library" || route.name === "reader" || route.name === "item" ? route.folder : undefined;
  const folder =
    folders.find((f) => f.id === wanted) ??
    (wanted ? undefined : (folders.find((f) => f.id === lastFolder()) ?? folders[0]));

  if (route.name === "reader" && folder) {
    return (
      <>
        <Suspense fallback={<div className="loading-screen" />}>
          <Reader key={`${folder.id}:${route.doc}`} folder={folder} doc={route.doc} page={route.page} find={route.find} />
        </Suspense>
        <Palette />
        <Shortcuts />
        <Toasts />
      </>
    );
  }

  return (
    <div className={`shell ${drawer ? "drawer-open" : ""}`}>
      <Sidebar active={route.name === "library" ? folder?.id : undefined} onNavigate={() => setDrawer(false)} />
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      {route.name === "today" ? (
        <Today onOpenSidebar={() => setDrawer(true)} />
      ) : route.name === "search" ? (
        <Search q={route.q ?? ""} onOpenSidebar={() => setDrawer(true)} />
      ) : route.name === "item" && folder ? (
        <ItemView key={route.item} folder={folder} id={route.item} />
      ) : route.name === "setup" ? (
        <Setup onOpenSidebar={() => setDrawer(true)} />
      ) : folder ? (
        <Library key={folder.id} folder={folder} onOpenSidebar={() => setDrawer(true)} />
      ) : (
        <main className="empty">
          <h2>That folder isn't on this device</h2>
          <p>It may have been removed, or it hasn't synced here yet.</p>
          <button className="btn btn-primary" onClick={() => navigate({ name: "library" })}>
            Go to your library
          </button>
        </main>
      )}
      <QuickAdd />
      <Palette />
      <Shortcuts />
      <Toasts />
    </div>
  );
}

/** The folder being looked at, so the save box saves there. */
function folderOnScreen(): { folder?: string } {
  const r = useUI.getState().route;
  return r.name === "library" || r.name === "item" ? { folder: r.folder } : {};
}
