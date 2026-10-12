/*
 * Page views for Engram's hosted site, counted by GoatCounter. Off unless VITE_GOATCOUNTER is set
 * to your GoatCounter code, so self-hosted copies count nothing by default.
 *
 * Only the screen is counted (today, library, item, search…). The folder and item IDs in the
 * address stay on the device.
 */

type Counter = { count: (vars: { path: string }) => void };

export function startAnalytics() {
  const code = import.meta.env.VITE_GOATCOUNTER;
  if (!code) return;

  const script = document.createElement("script");
  script.async = true;
  script.src = "//gc.zgo.at/count.js";
  script.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  // Count by hand: the app's addresses are hash routes, and the IDs in them must not be sent.
  script.dataset.goatcounterSettings = JSON.stringify({ no_onload: true });
  script.onload = countScreen;
  document.head.append(script);

  window.addEventListener("hashchange", countScreen);
}

function countScreen() {
  const screen = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "today";
  (window as Window & { goatcounter?: Counter }).goatcounter?.count({ path: `/${screen}` });
}
