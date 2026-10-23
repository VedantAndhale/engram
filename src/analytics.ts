import { useUI } from "./store/ui";
/*
 * Page views for Engram's hosted site, counted by GoatCounter. Off unless VITE_GOATCOUNTER is set
 * to your GoatCounter code, so self-hosted copies count nothing by default.
 *
 * Only the screen's name is sent (today, library, item, search…), as its path and its title.
 * GoatCounter's script isn't loaded: it would add the page title (an item's title), the
 * referrer and the address's query (Android shares arrive there). Its no-script counter, an
 * image with no referrer, sends nothing but what is set here.
 */



export function startAnalytics() {
  const code = import.meta.env.VITE_GOATCOUNTER;
  if (!code || !/^[a-z0-9-]+$/i.test(code)) return;
  const count = () => countScreen(code);
  count();
  // Each screen change is a page view. Only the screen's name is counted, never a folder or item ID.
  useUI.subscribe((s, prev) => {
    if (s.route.name !== prev.route.name) count();
  });
}

function countScreen(code: string) {
  // The screen's name only (today, library, item...): folder and item IDs stay on the device.
  const screen = useUI.getState().route.name;
  const url = new URL(`https://${code}.goatcounter.com/count`);
  url.searchParams.set("p", `/${screen}`);
  url.searchParams.set("t", screen);
  url.searchParams.set("rnd", Math.random().toString(36).slice(2, 8));
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.src = url.href;
}
