import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { startFolders, visibleFolders } from "./folders/registry";
import { evictCache } from "./store/actions";
import "./styles/app.css";
import { App } from "./ui/App";

registerSW({ immediate: true });

void navigator.storage?.persist?.();

startFolders()
  .then(async () => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await evictCache((await visibleFolders()).map((f) => f.id));
  })
  .catch((e) => {
    console.error(e);
    document.getElementById("root")!.textContent = "Engram couldn't start: " + (e instanceof Error ? e.message : String(e));
  });
