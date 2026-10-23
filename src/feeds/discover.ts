// Finds the feeds a web page advertises. Pure, so the tests can run it in Node.

/** The value of one attribute in an HTML tag, or undefined. Handles quoted and bare values. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3])?.replace(/&amp;/g, "&") : undefined;
}

/**
 * The RSS and Atom feeds a page advertises in its <link rel="alternate"> tags, as absolute web addresses,
 * resolved against the page's own address. A page that advertises none gives an empty list.
 */
export function feedLinksIn(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, "rel") ?? "";
    const type = attr(tag, "type") ?? "";
    const href = attr(tag, "href");
    if (!href || !/\balternate\b/i.test(rel) || !/(rss|atom)\+xml/i.test(type)) continue;
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol === "http:" || url.protocol === "https:") found.push(url.href);
    } catch {
      // A broken address is skipped.
    }
  }
  return [...new Set(found)];
}

/** The site an address belongs to, as its host name without "www.". */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
