// Feeds found from the articles the reader saves. Nothing is followed unless the reader presses Follow.
import { libraryOf } from "../folders/library";
import { folderCtx, visibleFolders } from "../folders/registry";
import { setFeedAsked, useHabit } from "../habit/prefs";
import { getAccount } from "../sync/account";
import { GitHub } from "../sync/github";
import { toast } from "../store/ui";
import { LINK_TYPES } from "../store/aging";
import { planFollow } from "./config";
import { feedLinksIn, siteOf } from "./discover";

const CONFIG_PATH = "feeds.json";
/** Most sites one scan looks at, so a large library does not keep the page busy for hours. */
const MAX_SITES_PER_SCAN = 200;
/** A pause between sites, so the sites and GitHub are not hit in a burst. */
const PAUSE_MS = 1500;

/** Sites the reader has decided about on this device: followed, declined, or checked with no feed. */
export function askedSites(): Set<string> {
  return new Set(useHabit.getState().feedAsked ?? []);
}

/** Remembers that the reader has decided about these sites, so they are not asked about again. */
export function recordFeedDecisions(sites: string[]) {
  setFeedAsked([...new Set([...askedSites(), ...sites])]);
}

/** Forgets decisions, so these sites can be offered again. */
export function forgetFeedDecisions(sites: string[]) {
  const drop = new Set(sites);
  setFeedAsked([...askedSites()].filter((s) => !drop.has(s)));
}

/** The library folder's GitHub client, or null when no GitHub folder is connected to take feeds. */
async function libraryClient(): Promise<GitHub | null> {
  const token = getAccount()?.token;
  const folder = libraryOf(await visibleFolders());
  if (!token || !folder?.repo) return null;
  return new GitHub(token, folder.repo);
}

const isConflict = (e: unknown) => {
  const status = (e as { status?: number } | null)?.status;
  return status === 409 || status === 422;
};

export type FollowResult = {
  /** How many feeds were added to the file in this call. */
  added: number;
  /** The addresses now followed: added, or already followed. */
  done: string[];
  /** How many of the addresses were not followed. */
  refused: number;
  /** Why some were refused, when some were. */
  reason?: string;
  /** Why nothing was saved at all. Set only when the file could not be read or written. */
  error?: string;
};

/**
 * Adds feed addresses to the library folder's feeds file, in one commit. Never throws: a failure comes back as
 * `error`, and nothing is written in that case. Tries once more if the file changed on GitHub in the meantime.
 */
export async function followFeeds(urls: string[]): Promise<FollowResult> {
  const failed = (error: string): FollowResult => ({ added: 0, done: [], refused: urls.length, error });
  try {
    const gh = await libraryClient();
    if (!gh) return failed("Connect a folder to GitHub first.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await gh.getFile(CONFIG_PATH);
      const plan = planFollow(current?.text ?? null, urls);
      if (!plan.ok) return failed(plan.error);
      if (!plan.changed) return { added: 0, done: plan.done, refused: plan.refused, reason: plan.reason };
      try {
        await gh.putFile(CONFIG_PATH, plan.text, current?.sha, "Follow feeds");
        return { added: plan.added, done: plan.done, refused: plan.refused, reason: plan.reason };
      } catch (e) {
        if (!isConflict(e)) throw e;
        if (attempt === 1) return failed("The feeds file kept changing. Try again.");
      }
    }
    return failed("The feeds file kept changing. Try again.");
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

/** A page's HTML through Engram's page reader, or undefined when it cannot be read. */
async function pageHtml(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/page?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The feed a site advertises: on the article's page, else on its front page. `checked` says whether any page could
 * be read, so a site that could not be reached is not recorded as having no feed.
 */
async function feedOf(pageUrl: string, html?: string): Promise<{ feed?: string; checked: boolean }> {
  const article = html ?? (await pageHtml(pageUrl));
  const first = article ? feedLinksIn(article, pageUrl)[0] : undefined;
  if (first) return { feed: first, checked: true };
  let home: string;
  try {
    home = new URL("/", pageUrl).href;
  } catch {
    return { checked: !!article };
  }
  const front = await pageHtml(home);
  const second = front ? feedLinksIn(front, home)[0] : undefined;
  return { feed: second, checked: !!article || !!front };
}

/**
 * After an article is saved, offers the feed its site advertises, once per site. The page HTML comes from the
 * bookmark when there is one, otherwise from Engram's page reader. A site is asked about once: dismissing the offer
 * counts as no, and the feed can still be added by hand in Setup. A failed Follow lets the site be offered again.
 */
export async function offerFeedFor(pageUrl: string, html?: string): Promise<void> {
  // A PDF's address is not read for feeds.
  if (/\.pdf($|[?#])/i.test(pageUrl)) return;
  const site = siteOf(pageUrl);
  if (!site || askedSites().has(site)) return;
  if (!(await libraryClient())) return;
  const { feed, checked } = await feedOf(pageUrl, html);
  // A site that could not be read is not decided, so it is tried again on a later save.
  if (!checked) return;
  recordFeedDecisions([site]);
  if (!feed) return;
  toast(`${site} has a feed. Follow it?`, {
    ttl: 12_000,
    action: { label: "Follow", run: () => void followAndReport(site, feed) },
  });
}

async function followAndReport(site: string, feed: string): Promise<void> {
  const r = await followFeeds([feed]);
  if (r.error || r.refused) {
    forgetFeedDecisions([site]);
    toast(`Could not follow ${site}: ${r.error ?? r.reason}`);
    return;
  }
  toast(r.added ? `Following ${site}. New articles will arrive in your library.` : `Already following ${site}.`);
}

export type FeedFound = { site: string; feed: string };
export type ScanResult = {
  found: FeedFound[];
  /** Sites looked at in this scan. */
  total: number;
  /** Sites that could be read, found or not. */
  checked: number;
  /** True when more sites are waiting than one scan looks at. */
  capped: boolean;
};

/**
 * Looks at one article per site, across the folders kept on GitHub, and reports the feed each site advertises. A
 * site's front page is tried when its article has no feed. Sites already decided on are skipped. Nothing is
 * followed here.
 */
export async function scanForFeeds(onProgress: (done: number, total: number) => void, stop: { current: boolean }): Promise<ScanResult> {
  const articleOf = new Map<string, string>();
  const decided = askedSites();
  for (const f of await visibleFolders()) {
    if (!f.repo) continue;
    await folderCtx(f.id).db.items.each((i) => {
      if (i.deleted || i.purged || !i.sourceUrl || !LINK_TYPES.includes(i.type) || /\.pdf($|[?#])/i.test(i.sourceUrl)) return;
      const site = siteOf(i.sourceUrl);
      if (!articleOf.has(site) && !decided.has(site)) articleOf.set(site, i.sourceUrl);
    });
  }
  const all = [...articleOf];
  const todo = all.slice(0, MAX_SITES_PER_SCAN);
  const found: FeedFound[] = [];
  let checked = 0;
  for (let n = 0; n < todo.length && !stop.current; n++) {
    const [site, page] = todo[n];
    onProgress(n, todo.length);
    const { feed, checked: reached } = await feedOf(page);
    if (reached) checked++;
    if (feed) found.push({ site, feed });
    else if (reached) recordFeedDecisions([site]);
    if (n + 1 < todo.length && !stop.current) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  onProgress(todo.length, todo.length);
  return { found, total: todo.length, checked, capped: all.length > MAX_SITES_PER_SCAN };
}
