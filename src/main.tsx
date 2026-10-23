// First: it takes a returning GitHub sign-in out of the address before the router reads it.
import { takeSignIn } from "./sync/signin";
import { refreshIfDue } from "./sync/refresh";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { completeSignIn, startFolders, visibleFolders } from "./folders/registry";
import "./lib/install"; // listen for the install prompt before it fires
import { startAnalytics } from "./analytics";
import { restoreAiNotes } from "./ai/notestore";
import { evictCache, keepStorage } from "./store/actions";
import { toast } from "./store/ui";
import "./styles/app.css";
import { Home, isFirstVisit } from "./landing/Home";
import { agingStart } from "./habit/prefs";

// A new version of the app is ready: it is used once you choose to reload, never in the middle of
// something (a share arriving, a note being typed).
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => toast("Update ready.", { action: { label: "Reload", run: () => void updateSW(true) }, ttl: 0 }),
});
startAnalytics();

void keepStorage();

// Keep an App sign-in fresh: its token lasts 8 hours. Also checks each 20 minutes while the app is open.
void refreshIfDue();
setInterval(() => void refreshIfDue(), 20 * 60_000);

startFolders()
  .then(async () => {
    // A first visit sees the landing page at the root before the app's welcome flow.
    const firstVisit = await isFirstVisit();
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Home firstVisit={firstVisit} />
      </StrictMode>,
    );
    const signIn = takeSignIn();
    if (signIn) void completeSignIn(signIn);
    // The AI notes kept on this device come back, so they survive a reload.
    void restoreAiNotes();
    await evictCache((await visibleFolders()).map((f) => f.id));
    // Records when the inbox rule began on this device. Links added before then keep their place in Inbox.
    agingStart();
  })
  .catch((e) => {
    console.error(e);
    document.getElementById("root")!.textContent = "Engram couldn't start: " + (e instanceof Error ? e.message : String(e));
  });
