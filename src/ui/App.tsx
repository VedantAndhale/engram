import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useEffect, useState } from "react";
import { folderCtx, visibleFolders } from "../folders/registry";
import { setHabit, useHabit } from "../habit/prefs";
import { lastFolder, navigate, useUI } from "../store/ui";
import { Toasts } from "./common";
import { Library } from "./Library";
import { Search } from "./Search";
import { Setup } from "./Setup";
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

  useEffect(() => setDrawer(false), [route]);

  // First run goes through the welcome flow. Anyone who already has documents has clearly started.
  const welcomed = useHabit((s) => s.welcomed);
  useEffect(() => {
    if (welcomed || !folders) return;
    void (async () => {
      for (const f of folders) {
        if (await folderCtx(f.id).db.items.filter((d) => !d.deleted).count()) return setHabit({ welcomed: true });
      }
      navigate({ name: "welcome" }, { replace: true });
    })();
  }, [welcomed, folders]);

  if (!folders) return null;

  if (route.name === "welcome") {
    return (
      <>
        <Welcome />
        <Toasts />
      </>
    );
  }

  // Which folder is on screen: the one in the address, else the last one used, else the first.
  const wanted = route.name === "library" || route.name === "reader" ? route.folder : undefined;
  const folder =
    folders.find((f) => f.id === wanted) ??
    (wanted ? undefined : (folders.find((f) => f.id === lastFolder()) ?? folders[0]));

  if (route.name === "reader" && folder) {
    return (
      <>
        <Suspense fallback={<div className="loading-screen" />}>
          <Reader key={`${folder.id}:${route.doc}`} folder={folder} doc={route.doc} page={route.page} find={route.find} />
        </Suspense>
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
      <Toasts />
    </div>
  );
}
