// First: it takes a returning GitHub sign-in out of the address before the router reads it.
import { takeSignIn } from "./sync/signin";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { completeSignIn, startFolders, visibleFolders } from "./folders/registry";
import "./lib/install"; // listen for the install prompt before it fires
import { startAnalytics } from "./analytics";
import { evictCache } from "./store/actions";
import "./styles/app.css";
import { App } from "./ui/App";

registerSW({ immediate: true });
startAnalytics();

void navigator.storage?.persist?.();

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
