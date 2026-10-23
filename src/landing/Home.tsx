import { useState } from "react";
import { folderCtx, visibleFolders } from "../folders/registry";
import { useHabit } from "../habit/prefs";
import { standalone } from "../lib/install";
import { navigate } from "../store/ui";
import { App } from "../ui/App";
import { Landing } from "./Landing";
import { APP_BASE } from "../lib/base";

/**
 * A first visit has no address hash, nothing saved in any folder, and has never been through the app's
 * welcome flow. Folders are created on first run, so a folder alone does not count. An installed app is
 * never a first visit: it opens the bare root too, and its people have used it.
 */
export async function isFirstVisit(): Promise<boolean> {
  // Only the bare root is a first visit. A shared link, a save link, a screen or a sign-in return is not.
  const bare = (location.pathname.endsWith("/") ? location.pathname.slice(0, -1) : location.pathname) === APP_BASE;
  if (!bare || location.search || location.hash.startsWith("#/") || location.hash.startsWith("#engram-auth")) return false;
  if (standalone() || useHabit.getState().welcomed) return false;
  for (const f of await visibleFolders()) {
    if (await folderCtx(f.id).db.items.filter((d) => !d.deleted).count()) return false;
  }
  return true;
}

/**
 * The site's root. A first visit gets the landing page. "Open Engram" opens the app's first screen, and
 * the app takes over. Every other visit, including the bookmarklet and sign-in returns, which carry a
 * path or a hash, goes straight to the app.
 */
export function Home({ firstVisit }: { firstVisit: boolean }) {
  const [landing, setLanding] = useState(firstVisit);

  return landing ? (
    <Landing
      onOpen={() => {
        navigate({ name: "today" });
        setLanding(false);
      }}
    />
  ) : (
    <App />
  );
}
