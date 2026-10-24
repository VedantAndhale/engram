// engram-feeds v2
// Fetches the RSS/Atom feeds listed in feeds.json and writes new entries into inbox/ as
// Markdown files for the Engram app. Zero dependencies; runs on Node 22 inside a GitHub Action.
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_FEEDS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 8;
// 500 feeds, 8 at a time, with every fetch timing out, is about 16 minutes. The job gets 30.
const RUN_LIMIT_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_MS = 7 * DEFAULT_RETRY_MS;
const FIRST_RUN_ENTRIES = 5;
// Twice a day, so 60 per run matches the 30-per-six-hours the Action wrote before.
const MAX_WRITES = 60;
// Remembered items per feed. At 500 feeds this keeps state.json to a few MB.
const LEDGER_CAP = 300;
const MAX_DEPTH = 256;
const TITLE_CAP = 300;
const SUMMARY_CAP = 1000;
const FEED_TITLE_CAP = 120;
const USER_AGENT = "Engram-feeds/1.0 (+https://engram.vedant.me)";
const ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";
const MARKER = "<!-- engram:";

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const HTML_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};
// Tags that separate words, so stripping them must leave a space behind.
const BLOCK_TAGS = new Set([
  "p", "br", "div", "li", "ul", "ol", "tr", "td", "th", "table", "hr",
  "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
]);

const sha1 = (text) => createHash("sha1").update(text).digest("hex");
// Own-property lookup so ids like "constructor" never hit Object.prototype.
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);
const uniq = (list) => [...new Set(list)];
const isSpace = (c) => c === " " || c === "\n" || c === "\t" || c === "\r";
const isLetter = (c) => {
  const k = c.charCodeAt(0) | 32;
  return k >= 97 && k <= 122;
};
const isNameStart = (c) => isLetter(c) || c === "_" || c === ":";
const local = (name) => {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
};

export class FeedParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedParseError";
  }
}

export function entryKey(feedId, guid) {
  return sha1(`${feedId}\n${guid}`).slice(0, 16);
}

// ---------- text pipeline ----------

function entityValue(name, table) {
  if (name[0] === "#") {
    const hex = name[1] === "x" || name[1] === "X";
    const digits = name.slice(hex ? 2 : 1);
    if (!digits || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
    const cp = parseInt(digits, hex ? 16 : 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : null;
  }
  return Object.hasOwn(table, name) ? table[name] : null;
}

// One pass, so "&amp;lt;" becomes "&lt;" and is not decoded a second time.
function decodeEntities(s, table) {
  let amp = s.indexOf("&");
  if (amp === -1) return s;
  let out = "";
  let last = 0;
  let semi = -1;
  while (amp !== -1) {
    // Reuse the last ";" until it is behind us, so a long run of "&" stays linear.
    if (semi <= amp) {
      semi = s.indexOf(";", amp + 1);
      if (semi === -1) break;
    }
    const value = semi - amp <= 12 ? entityValue(s.slice(amp + 1, semi), table) : null;
    if (value !== null) {
      out += s.slice(last, amp) + value;
      last = semi + 1;
      amp = s.indexOf("&", last);
    } else {
      amp = s.indexOf("&", amp + 1);
    }
  }
  return out + s.slice(last);
}

function tagName(s, lt) {
  let i = lt + 1;
  if (s[i] === "/") i++;
  let j = i;
  while (j < s.length && j - i < 12 && (isLetter(s[j]) || (s[j] >= "0" && s[j] <= "9"))) j++;
  return s.slice(i, j).toLowerCase();
}

function stripTags(s) {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt === -1) break;
    const c = s[lt + 1];
    // A bare "<" (as in "a < b") is text, not markup.
    if (c === undefined || !(isLetter(c) || c === "/" || c === "!" || c === "?")) {
      out += s.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    out += s.slice(i, lt);
    let end;
    if (s.startsWith("<!--", lt)) {
      end = s.indexOf("-->", lt + 4);
      if (end !== -1) end += 2;
    } else {
      end = s.indexOf(">", lt + 1);
    }
    if (end === -1) return out; // unterminated tag: drop the rest
    if (BLOCK_TAGS.has(tagName(s, lt))) out += " ";
    i = end + 1;
  }
  return out + s.slice(i);
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();

function cap(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(n - 1);
  // Never leave half of a surrogate pair at the end.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// Input text already had XML entities decoded (or came from CDATA, which has none).
const cleanText = (raw, n) => cap(collapse(decodeEntities(stripTags(raw), HTML_ENTITIES)), n);

// ---------- XML scanner ----------

function readTag(src, start) {
  const n = src.length;
  let i = start + 1;
  const closing = src[i] === "/";
  if (closing) i++;
  const nameStart = i;
  while (i < n && !isSpace(src[i]) && src[i] !== ">" && src[i] !== "/") i++;
  const name = local(src.slice(nameStart, i));
  const attrs = Object.create(null);
  let selfClosing = false;
  for (;;) {
    while (i < n && isSpace(src[i])) i++;
    if (i >= n) throw new FeedParseError("unterminated tag at end of input");
    const c = src[i];
    if (c === ">") {
      i++;
      break;
    }
    if (c === "/") {
      if (src[i + 1] === ">") {
        selfClosing = true;
        i += 2;
        break;
      }
      i++;
      continue;
    }
    const attrStart = i;
    while (i < n && !isSpace(src[i]) && src[i] !== "=" && src[i] !== ">" && src[i] !== "/") i++;
    const attrName = src.slice(attrStart, i);
    while (i < n && isSpace(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < n && isSpace(src[i])) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        if (close === -1) throw new FeedParseError("unterminated attribute value");
        value = src.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(src[i]) && src[i] !== ">") i++;
        value = src.slice(valueStart, i);
      }
    }
    const key = local(attrName);
    const isNamespace = attrName === "xmlns" || attrName.startsWith("xmlns:");
    if (key && !isNamespace && !(key in attrs)) attrs[key] = decodeEntities(value, XML_ENTITIES);
  }
  return { name, attrs, closing, selfClosing, end: i };
}

// A DOCTYPE with an internal subset is how entity bombs are delivered, so it is refused.
function skipDeclaration(src, lt) {
  const isDoctype = src.slice(lt, lt + 9).toUpperCase() === "<!DOCTYPE";
  let i = lt + 2;
  while (i < src.length) {
    const c = src[i];
    if (c === ">") return i + 1;
    if (isDoctype && c === "[") throw new FeedParseError("DOCTYPE with an internal subset is not allowed");
    if (isDoctype && (c === '"' || c === "'")) {
      const close = src.indexOf(c, i + 1);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    i++;
  }
  throw new FeedParseError("unterminated declaration at end of input");
}

// Builds a tree of { name, attrs, children } where children are strings or elements.
function parseXml(src) {
  if (!src || !src.trim()) throw new FeedParseError("empty feed");
  const doc = { name: "#document", attrs: Object.create(null), children: [] };
  const stack = [doc];
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushText = (top, text) => {
    if (top !== doc && text) top.children.push(text);
  };
  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      pushText(top, decodeEntities(src.slice(i), XML_ENTITIES));
      break;
    }
    if (lt > i) pushText(top, decodeEntities(src.slice(i, lt), XML_ENTITIES));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) throw new FeedParseError("unterminated comment at end of input");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end === -1) throw new FeedParseError("unterminated CDATA at end of input");
      pushText(top, src.slice(lt + 9, end)); // CDATA is raw: no entity decoding
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) throw new FeedParseError("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      i = skipDeclaration(src, lt);
      continue;
    }
    const next = src[lt + 1];
    if (next === undefined) throw new FeedParseError("unterminated tag at end of input");
    if (next !== "/" && !isNameStart(next)) {
      pushText(top, "<");
      i = lt + 1;
      continue;
    }
    const tag = readTag(src, lt);
    i = tag.end;
    if (tag.closing) {
      // A close tag that does not match pops to the nearest open tag of that name, or is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === tag.name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    if (stack.length > MAX_DEPTH) throw new FeedParseError("elements are nested too deeply");
    const el = { name: tag.name, attrs: tag.attrs, children: [] };
    top.children.push(el);
    if (!tag.selfClosing) stack.push(el);
  }
  return doc;
}

const isEl = (node) => typeof node !== "string";
const kids = (el, name) => el.children.filter((c) => isEl(c) && c.name === name);

// All text under an element, walked without recursion so deep nesting cannot overflow the stack.
function textOf(el) {
  let out = "";
  const todo = [el];
  while (todo.length) {
    const node = todo.pop();
    if (typeof node === "string") {
      out += node;
      continue;
    }
    if (node !== el) {
      out += " ";
      todo.push(" ");
    }
    for (let k = node.children.length - 1; k >= 0; k--) todo.push(node.children[k]);
  }
  return out;
}

function firstRaw(el, names) {
  for (const name of names) {
    for (const child of kids(el, name)) {
      const text = textOf(child).trim();
      if (text) return text;
    }
  }
  return "";
}

function firstClean(el, names, limit) {
  for (const name of names) {
    for (const child of kids(el, name)) {
      const text = cleanText(textOf(child), limit);
      if (text) return text;
    }
  }
  return "";
}

// Atom: rel "alternate" or no rel, href attribute. RSS: the element text. Self/enclosure are ignored.
function pickLink(item) {
  for (const link of kids(item, "link")) {
    const href = link.attrs.href;
    if (href !== undefined) {
      const rel = link.attrs.rel;
      if (href.trim() && (rel === undefined || rel === "" || rel === "alternate")) return href.trim();
      continue;
    }
    const text = textOf(link).trim();
    if (text) return text;
  }
  return "";
}

function resolveHttp(raw, base) {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const RSS_FIELDS = { summary: ["description", "encoded"], date: ["pubDate", "date"] };
const ATOM_FIELDS = { summary: ["summary", "content"], date: ["published", "updated"] };

function readEntry(item, atom, feedUrl) {
  const fields = atom ? ATOM_FIELDS : RSS_FIELDS;
  const title = firstClean(item, ["title"], TITLE_CAP);
  const dateText = firstRaw(item, fields.date);
  if (!title && !dateText) return null;
  const guidText = firstRaw(item, ["guid", "id"]);
  // RSS 1.0 items carry their address in rdf:about; some RSS items only have a permalink guid.
  let rawLink = pickLink(item) || item.attrs.about || "";
  if (!rawLink && /^https?:/i.test(guidText)) rawLink = guidText;
  const link = resolveHttp(rawLink, feedUrl);
  const guid = guidText || link || sha1(title + dateText);
  if (!link) return null;
  let published = null;
  if (dateText) {
    const ms = Date.parse(dateText);
    if (Number.isFinite(ms)) published = new Date(ms).toISOString();
  }
  return { guid, title, link, summary: firstClean(item, fields.summary, SUMMARY_CAP), published };
}

export function parseFeed(xmlText, feedUrl) {
  const doc = parseXml(typeof xmlText === "string" ? xmlText : "");
  const root = doc.children.find(isEl);
  if (!root || !(root.name === "rss" || root.name === "RDF" || root.name === "feed")) {
    throw new FeedParseError("not an RSS or Atom feed");
  }
  const atom = root.name === "feed";
  let head = root;
  let items;
  if (atom) {
    items = kids(root, "entry");
  } else {
    const channel = kids(root, "channel")[0];
    head = channel || root;
    // RSS 2.0 keeps items inside channel; RSS 1.0 (RDF) puts them beside it.
    items = [...(channel ? kids(channel, "item") : []), ...kids(root, "item")];
  }
  const titleEl = kids(head, "title")[0];
  const title = titleEl ? cleanText(textOf(titleEl), FEED_TITLE_CAP) : "";
  const entries = [];
  for (const item of items) {
    const entry = readEntry(item, atom, feedUrl);
    if (entry) entries.push(entry);
  }
  return { title, entries };
}

// ---------- inbox file ----------

// The app reads this marker as a content block, so it must never appear in feed text.
function stripMarker(text) {
  let out = text;
  while (out.includes(MARKER)) out = out.split(MARKER).join("");
  return out;
}

export function inboxFileText(entry, feed, createdAt) {
  const lines = ["---", 'engram: "inbox@1"', 'kind: "save"', 'agent: "feeds"'];
  lines.push(`created_at: ${JSON.stringify(createdAt)}`);
  const label = stripMarker(String((feed && feed.title) ?? "")).trim();
  if (label) lines.push(`why: ${JSON.stringify(`From ${label}`)}`);
  lines.push(`title: ${JSON.stringify(stripMarker(entry.title || entry.link))}`);
  lines.push(`source_url: ${JSON.stringify(entry.link)}`, "---");
  const body = collapse(stripMarker(entry.summary ?? ""));
  return lines.join("\n") + "\n" + (body ? `\n${body}\n` : "");
}

// ---------- config and state ----------

function normaliseUrl(text) {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function validateFeeds(json) {
  const feeds = [];
  const errors = [];
  const list = json && typeof json === "object" ? json.feeds : null;
  if (!Array.isArray(list)) return { feeds, errors: ["feeds.json: expected a feeds list"] };
  const ids = new Set();
  const urls = new Set();
  let extra = 0;
  for (let index = 0; index < list.length; index++) {
    const raw = list[index];
    const where = `feeds.json entry ${index + 1}`;
    if (feeds.length >= MAX_FEEDS) {
      extra++;
      continue;
    }
    if (!raw || typeof raw !== "object") {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(raw.id)) {
      errors.push(`${where}: bad id`);
      continue;
    }
    const normal = typeof raw.url === "string" ? normaliseUrl(raw.url) : null;
    if (!normal) {
      errors.push(`${where}: url must be http or https`);
      continue;
    }
    if (ids.has(raw.id)) {
      errors.push(`${where}: duplicate id ${raw.id}`);
      continue;
    }
    if (urls.has(normal)) {
      errors.push(`${where}: duplicate url ${normal}`);
      continue;
    }
    ids.add(raw.id);
    urls.add(normal);
    feeds.push({
      id: raw.id,
      url: raw.url.trim(),
      title: typeof raw.title === "string" ? cap(collapse(raw.title), FEED_TITLE_CAP) : "",
      addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : 0,
    });
  }
  if (extra) errors.push(`feeds.json: more than ${MAX_FEEDS} feeds, ignored ${extra}`);
  return { feeds, errors };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

// Sorted keys and a trailing newline, so an unchanged state is byte-for-byte identical.
export function serializeState(state) {
  return JSON.stringify(sortKeys(state), null, 2) + "\n";
}

function cleanFeedState(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.url !== "string") return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const err = raw.lastError;
  return {
    url: raw.url,
    title: typeof raw.title === "string" ? raw.title : "",
    etag: str(raw.etag),
    lastModified: str(raw.lastModified),
    retryAfter: str(raw.retryAfter),
    lastError:
      err && typeof err === "object" && typeof err.message === "string"
        ? { message: err.message, since: typeof err.since === "string" ? err.since : "" }
        : null,
    seen: Array.isArray(raw.seen) ? raw.seen.filter((k) => typeof k === "string") : [],
  };
}

function cleanState(state) {
  const out = {};
  const src = state && state.feeds && typeof state.feeds === "object" ? state.feeds : {};
  for (const id of Object.keys(src)) {
    if (id === "__proto__") continue;
    const feedState = cleanFeedState(src[id]);
    if (feedState) out[id] = feedState;
  }
  return out;
}

function isHeld(feedState, nowMs) {
  if (!feedState || !feedState.retryAfter) return false;
  const until = Date.parse(feedState.retryAfter);
  return Number.isFinite(until) && until > nowMs;
}

// Starting point for a feed's new state when the fetch failed.
function baseState(prev, feed) {
  // Validators belong to one URL; if the URL changed they would be wrong.
  const same = Boolean(prev) && prev.url === feed.url;
  return {
    url: feed.url,
    title: feed.title || (prev ? prev.title : ""),
    etag: same ? prev.etag : null,
    lastModified: same ? prev.lastModified : null,
    retryAfter: null,
    lastError: null,
    seen: prev ? prev.seen : [],
  };
}

function uniqueByKey(items) {
  const seen = new Set();
  return items.filter((item) => !seen.has(item.key) && seen.add(item.key));
}

// ---------- planning (pure) ----------

export function planRun({ feeds, state, fetched, now }) {
  const nowMs = Number(now);
  const nowIso = new Date(nowMs).toISOString();
  const prevFeeds = cleanState(state);
  const nextFeeds = {};
  const errors = [];
  const queues = [];

  for (const feed of feeds) {
    const prev = own(prevFeeds, feed.id) ?? null;
    const res = !fetched ? undefined : fetched instanceof Map ? fetched.get(feed.id) : own(fetched, feed.id);
    // Held feeds and feeds nobody fetched keep their state exactly as it was.
    if (!res || isHeld(prev, nowMs)) {
      if (prev) nextFeeds[feed.id] = prev;
      continue;
    }
    // A 304 means the feed answered fine, so an error from an earlier run no longer applies.
    if (res.kind === "notModified") {
      if (prev) nextFeeds[feed.id] = { ...prev, retryAfter: null, lastError: null };
      continue;
    }
    if (res.kind === "error") {
      const message = String(res.message);
      // A run that ran out of time says nothing about the feed, so its last real error stays until a fetch reaches it.
      if (message === "deadline" && prev && prev.lastError && prev.lastError.message !== "deadline") {
        nextFeeds[feed.id] = prev;
        errors.push({ feedId: feed.id, message });
        continue;
      }
      const keepSince = prev && prev.lastError && prev.lastError.message === message && prev.lastError.since;
      nextFeeds[feed.id] = {
        ...baseState(prev, feed),
        retryAfter: res.retryAfter ?? null,
        // "since" only moves when the message changes, so a steady failure leaves state untouched.
        lastError: { message, since: keepSince || nowIso },
      };
      errors.push({ feedId: feed.id, message });
      continue;
    }

    const label = feed.title || res.title || "";
    const entries = uniqueByKey(
      res.entries.slice(0, LEDGER_CAP).map((entry) => ({ key: entryKey(feed.id, entry.guid), entry })),
    );
    const ledger = prev ? prev.seen : [];
    const known = new Set(ledger);
    // An empty ledger means nothing was ever recorded, so a feed that failed on its first
    // fetch is still treated as new instead of importing its whole history.
    let first = ledger.length === 0;
    // A long list where nothing is known means the guid scheme changed: start over.
    if (!first && entries.length > FIRST_RUN_ENTRIES && !entries.some((e) => known.has(e.key))) first = true;
    // Feeds list newest first, so the head of the list is what a new subscriber wants.
    const queue = first ? entries.slice(0, FIRST_RUN_ENTRIES) : entries.filter((e) => !known.has(e.key));
    const older = first ? entries.slice(FIRST_RUN_ENTRIES).map((e) => e.key) : [];
    queues.push({ feed, label, res, prev, queue, older, written: [] });
  }

  // Round-robin so one busy feed cannot crowd out the others.
  const writes = [];
  let progress = true;
  while (writes.length < MAX_WRITES && progress) {
    progress = false;
    for (const q of queues) {
      if (writes.length >= MAX_WRITES) break;
      const next = q.queue.shift();
      if (!next) continue;
      progress = true;
      const feedInfo = { id: q.feed.id, title: q.label };
      writes.push({ path: `inbox/feed-${next.key}.md`, text: inboxFileText(next.entry, feedInfo, nowIso) });
      q.written.push(next.key);
    }
  }

  // Entries left in a queue stay out of the ledger, so the next run picks them up.
  for (const q of queues) {
    const seen = uniq([...q.written, ...q.older, ...(q.prev ? q.prev.seen : [])]).slice(0, LEDGER_CAP);
    nextFeeds[q.feed.id] = {
      url: q.feed.url,
      title: q.label,
      etag: q.res.etag ?? null,
      lastModified: q.res.lastModified ?? null,
      retryAfter: null,
      lastError: null,
      seen,
    };
  }

  const nextState = { version: 1, updatedAt: nowIso, feeds: nextFeeds };
  const prevBytes = serializeState({ version: 1, updatedAt: "", feeds: prevFeeds });
  const nextBytes = serializeState({ version: 1, updatedAt: "", feeds: nextFeeds });
  // Only touch updatedAt when something else changed, so a quiet run leaves identical bytes.
  if (state && typeof state.updatedAt === "string" && prevBytes === nextBytes) {
    nextState.updatedAt = state.updatedAt;
  }
  return { writes, state: nextState, errors };
}

// ---------- fetching ----------

async function readLimited(res) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function sniffBom(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

function sniffProlog(bytes) {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 512));
  const start = head.indexOf("<?xml");
  if (start === -1) return null;
  const end = head.indexOf("?>", start);
  if (end === -1) return null;
  const decl = head.slice(start, end);
  const at = decl.indexOf("encoding");
  if (at === -1) return null;
  let i = decl.indexOf("=", at + 8);
  if (i === -1) return null;
  i++;
  while (decl[i] === " ") i++;
  const quote = decl[i];
  if (quote !== '"' && quote !== "'") return null;
  const close = decl.indexOf(quote, i + 1);
  return close === -1 ? null : decl.slice(i + 1, close).trim();
}

function decodeBody(bytes, contentType) {
  let label = null;
  const ct = (contentType || "").toLowerCase();
  const at = ct.indexOf("charset=");
  if (at !== -1) {
    let end = ct.indexOf(";", at);
    if (end === -1) end = ct.length;
    label = ct.slice(at + 8, end).trim().replace(/^["']|["']$/g, "");
  }
  if (!label) label = sniffBom(bytes) || sniffProlog(bytes);
  let decoder;
  try {
    decoder = new TextDecoder(label || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8"); // unknown label: fall back rather than fail the feed
  }
  return decoder.decode(bytes);
}

function retryAfterIso(header, nowMs) {
  let ms = DEFAULT_RETRY_MS;
  const value = header ? header.trim() : "";
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const at = Date.parse(value);
      if (Number.isFinite(at)) ms = at - nowMs;
    }
  }
  // A hostile header must not park a feed forever.
  return new Date(nowMs + Math.min(Math.max(ms, 0), MAX_RETRY_MS)).toISOString();
}

function describeError(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  const code = err && err.cause && err.cause.code ? ` (${err.cause.code})` : "";
  const text = String(err && err.message ? err.message : err).replace(/\s+/g, " ").trim();
  return (text + code).slice(0, 200);
}

async function drain(res) {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing useful to do if the body is already gone.
  }
}

async function fetchOne(feed, prev, fetchImpl, nowMs) {
  const headers = { "User-Agent": USER_AGENT, Accept: ACCEPT };
  // Validators only make sense for the URL they were stored against.
  if (prev && prev.url === feed.url) {
    if (prev.etag) headers["If-None-Match"] = prev.etag;
    if (prev.lastModified) headers["If-Modified-Since"] = prev.lastModified;
  }
  try {
    const res = await fetchImpl(feed.url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 304) {
      await drain(res);
      return { kind: "notModified" };
    }
    if (res.status === 429 || res.status === 503) {
      await drain(res);
      return {
        kind: "error",
        message: `HTTP ${res.status}`,
        retryAfter: retryAfterIso(res.headers.get("retry-after"), nowMs),
      };
    }
    if (!res.ok) {
      await drain(res);
      return { kind: "error", message: `HTTP ${res.status}` };
    }
    const bytes = await readLimited(res);
    if (!bytes) return { kind: "error", message: "too large" };
    const text = decodeBody(bytes, res.headers.get("content-type"));
    const parsed = parseFeed(text, res.url || feed.url);
    return {
      kind: "ok",
      title: parsed.title,
      entries: parsed.entries,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  } catch (err) {
    if (err instanceof FeedParseError) return { kind: "error", message: `parse error: ${err.message}` };
    return { kind: "error", message: describeError(err) };
  }
}

async function fetchAll(todo, prevFeeds, fetchImpl, now, out) {
  const startedAt = now();
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const feed = todo[next++];
      // Past the run limit, the remaining feeds are reported instead of fetched.
      out[feed.id] =
        now() - startedAt >= RUN_LIMIT_MS
          ? { kind: "error", message: "deadline" }
          : await fetchOne(feed, own(prevFeeds, feed.id), fetchImpl, now());
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));
}

// ---------- files and entry point ----------

async function readIfExists(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function parseState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const ok =
    raw && typeof raw === "object" && raw.version === 1 && raw.feeds && typeof raw.feeds === "object" &&
    !Array.isArray(raw.feeds);
  // Overwriting a state we cannot read would re-import every feed, so stop instead.
  if (!ok) throw new Error("feeds/state.json exists but cannot be read; nothing was changed");
  return raw;
}

// "wx" never overwrites: a file that already exists was written by an earlier run.
async function writeNew(file, text) {
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (err) {
    if (err && err.code === "EEXIST") return;
    throw err;
  }
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

export async function main({ root = process.cwd(), fetchImpl = fetch, now = Date.now, log = console.log } = {}) {
  const feedsText = await readIfExists(path.join(root, "feeds.json"));
  if (feedsText === null) {
    log("engram-feeds: no feeds.json");
    return { written: 0, errors: 0 };
  }
  let json;
  try {
    json = JSON.parse(feedsText);
  } catch {
    log("engram-feeds: feeds.json is not valid JSON");
    return { written: 0, errors: 1 };
  }
  // Without a list there is nothing to compare against, and the state must not be wiped.
  if (!json || !Array.isArray(json.feeds)) {
    log("engram-feeds: feeds.json has no feeds list");
    return { written: 0, errors: 1 };
  }
  const { feeds, errors: configErrors } = validateFeeds(json);

  // Read the state before any work, so a corrupt file stops the run with nothing written.
  const statePath = path.join(root, "feeds", "state.json");
  const stateText = await readIfExists(statePath);
  const state = stateText === null ? null : parseState(stateText);

  const nowMs = now();
  const prevFeeds = cleanState(state);
  const fetched = {};
  const todo = feeds.filter((feed) => !isHeld(own(prevFeeds, feed.id), nowMs));
  await fetchAll(todo, prevFeeds, fetchImpl, now, fetched);
  const plan = planRun({ feeds, state, fetched, now: nowMs });

  if (plan.writes.length) await mkdir(path.join(root, "inbox"), { recursive: true });
  for (const write of plan.writes) await writeNew(path.join(root, write.path), write.text);

  const nextText = serializeState(plan.state);
  // No point creating an empty state file for a repo that has no feeds yet.
  if (nextText !== stateText && !(stateText === null && feeds.length === 0)) {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, nextText, "utf8");
  }

  const urls = new Map(feeds.map((feed) => [feed.id, feed.url]));
  const lines = [
    ...configErrors.map((message) => `  ${message}`),
    ...plan.errors.map((e) => `  ${urls.get(e.feedId) ?? e.feedId}: ${e.message}`),
  ];
  const notModified = Object.values(fetched).filter((r) => r.kind === "notModified").length;
  log(`engram-feeds: ${feeds.length} feeds, ${plan.writes.length} new, ${notModified} not modified, ${lines.length} errors`);
  for (const line of lines) log(line);
  return { written: plan.writes.length, errors: lines.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`engram-feeds: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}