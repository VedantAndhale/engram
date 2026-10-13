/*
 * GET /api/page?url=…: fetch a web page for the app, which can't read other sites itself
 * (browsers block that). Links saved from a phone or by pasting arrive with no text; the app
 * fetches the page through here and picks out the article on the device. Nothing is stored or
 * logged. Only Engram's own pages may call it, it only fetches public http(s) addresses, and it
 * only returns HTML, capped in size.
 */

import { lookup } from "node:dns/promises";

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

/** Hosts that are this machine or a private network. Names are checked as written, which covers what matters on a serverless host. */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) {
    // IPv6: loopback, unspecified, unique-local, link-local, and IPv4 written inside IPv6.
    if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true;
    const mapped = /^(?:0*:)*(?:0*:)?ffff:(?:0+:)?(.+)$/.exec(h)?.[1];
    if (!mapped) return false;
    if (mapped.includes(".")) return privateHost(mapped);
    // The URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
    const [hi, lo] = mapped.split(":").map((p) => parseInt(p, 16));
    return hi === undefined || lo === undefined || Number.isNaN(hi) || Number.isNaN(lo) || privateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** A name that resolves to this machine or a private network, so DNS can't sneak past the check above. */
async function resolvesPrivate(host: string): Promise<boolean> {
  try {
    return (await lookup(host.replace(/^\[|\]$/g, ""), { all: true })).some((a) => privateHost(a.address));
  } catch {
    return false; // An unknown name: the fetch below fails on its own.
  }
}

const fail = (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });

export async function page(req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405 });
  // Browsers say where a request comes from; other sites' pages can't use this as a proxy.
  if (req.headers.get("sec-fetch-site") !== "same-origin") return fail(403, "Only Engram can use this.");
  // Only the app's own fetch() may read pages here. Opened as a page (a link in a saved
  // article, say), the fetched HTML would run as Engram, with the user's sign-in.
  if (req.headers.get("sec-fetch-mode") === "navigate" || (req.headers.get("sec-fetch-dest") ?? "empty") !== "empty") {
    return fail(403, "Only Engram can use this.");
  }
  let url: URL;
  try {
    url = new URL(new URL(req.url).searchParams.get("url") ?? "");
  } catch {
    return fail(400, "That isn't a web address.");
  }

  // Follow redirects by hand, so each hop is checked too.
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(url.protocol) || privateHost(url.hostname) || (await resolvesPrivate(url.hostname))) return fail(400, "Engram only fetches public web pages.");
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Engram/1.0; +https://engram.vedant.me)",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
      });
    } catch {
      return fail(502, "That page didn't answer.");
    }
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) break;
    url = new URL(next, url);
    res = undefined;
  }
  if (!res) return fail(502, "That page redirects too many times.");
  if (!res.ok) return fail(502, `That page answered ${res.status}.`);
  if (!/html/i.test(res.headers.get("content-type") ?? "")) return fail(415, "That address isn't a web page.");

  // Read up to the cap and stop; a huge page is cut, not refused.
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  void reader.cancel().catch(() => {});
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
  let html: string;
  try {
    html = new TextDecoder(charset).decode(Buffer.concat(chunks));
  } catch {
    html = new TextDecoder().decode(Buffer.concat(chunks));
  }
  // Sent as text that never renders: the app parses it itself, and nothing in it can run here.
  return new Response(html, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": "attachment",
      "X-Final-Url": url.href,
      "Cache-Control": "private, max-age=600",
    },
  });
}
