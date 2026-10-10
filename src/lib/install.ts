import { create } from "zustand";

/*
 * Installing Engram as an app. Chrome on Android (and desktop) fires `beforeinstallprompt` once,
 * early, so it is caught at startup and kept until the reader asks to install. iPhone and iPad
 * have no such prompt: Safari installs from Share → Add to Home Screen, so that is explained instead.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface InstallState {
  /** Set while the browser is ready to install the app. */
  prompt: InstallPromptEvent | null;
  installed: boolean;
}

const standalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export const useInstall = create<InstallState>(() => ({ prompt: null, installed: standalone() }));

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // show our own button instead of the browser's banner
  useInstall.setState({ prompt: e as InstallPromptEvent });
});
window.addEventListener("appinstalled", () => useInstall.setState({ prompt: null, installed: true }));

/** iPhone and iPad, including iPads that report themselves as a Mac. */
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Show the browser's install dialog. Returns true if the reader installed. */
export async function installApp(): Promise<boolean> {
  const { prompt } = useInstall.getState();
  if (!prompt) return false;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  useInstall.setState({ prompt: null }); // each prompt can be used once
  return outcome === "accepted";
}
