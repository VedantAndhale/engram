// First: it takes a returning GitHub sign-in out of the address before the router reads it.
import { takeSignIn } from "./sync/signin";
import { refreshIfDue } from "./sync/refresh";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { completeSignIn, startFolders, visibleFolders } from "./folders/registry";
import "./lib/install"; // listen for the install prompt before it fires
import { startAnalytics } from "./analytics";
import { evictCache, keepStorage } from "./store/actions";
import { toast } from "./store/ui";
import "./styles/app.css";
import { App } from "./ui/App";

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
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    const signIn = takeSignIn();
    if (signIn) void completeSignIn(signIn);
    await evictCache((await visibleFolders()).map((f) => f.id));
  })
  .catch((e) => {
    console.error(e);
    document.getElementById("root")!.textContent = "Engram couldn't start: " + (e instanceof Error ? e.message : String(e));
  });
