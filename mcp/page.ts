/*
 * GET /api/page?url=…: fetch a web page for the app, which can't read other sites itself
 * (browsers block that). Links saved from a phone or by pasting arrive with no text; the app
 * fetches the page through here and picks out the article on the device. Nothing is stored or
 * logged. Only Engram's own pages may call it, it only fetches public http(s) addresses, and it
 * only returns HTML, capped in size.
 */

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

/** Hosts that are this machine or a private network. Names are checked as written, which covers what matters on a serverless host. */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const fail = (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });

export async function page(req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405 });
  // Browsers say where a request comes from; other sites' pages can't use this as a proxy.
  if (req.headers.get("sec-fetch-site") !== "same-origin") return fail(403, "Only Engram can use this.");
  let url: URL;
  try {
    url = new URL(new URL(req.url).searchParams.get("url") ?? "");
  } catch {
    return fail(400, "That isn't a web address.");
  }

  // Follow redirects by hand, so each hop is checked too.
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(url.protocol) || privateHost(url.hostname)) return fail(400, "Engram only fetches public web pages.");
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
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Final-Url": url.href, "Cache-Control": "private, max-age=600" },
  });
}
