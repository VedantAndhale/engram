import { useEffect, useMemo, useState } from "react";
import type { Folder } from "../model";
import { getAccount } from "../sync/account";
import { GitHub } from "../sync/github";
import { MAX_FEEDS, checkFeedsText, parseFeedsJson, type FeedsFile } from "../feeds/config";
import { planAddFeed, planRemoveFeed, type RawPlan } from "../feeds/raw";
import { FEED_INSTALL_FILES, checkInstall } from "../feeds/install";
import { putFeedScript } from "../feeds/putscript";
import { feedStatus, statusRank, type FeedRunState, type FeedStatus } from "../feeds/status";
import { FindFeeds } from "./FindFeeds";

type Loaded = { data: FeedsFile; sha: string | undefined };
type RunFeeds = Record<string, FeedRunState & { title?: string }>;
// What the feeds Action wrote to feeds/state.json. `problem` is set when the Action cannot read that file.
type RunState = { feeds: RunFeeds; problem: string | null };
type Status = Awaited<ReturnType<typeof checkInstall>>;
type AddMessage = { ok: boolean; text: string };

const CONFIG_PATH = "feeds.json";
const STATE_PATH = "feeds/state.json";
const SCRIPT_PATH = "feeds/action/fetch-feeds.mjs";
const WORKFLOW_PATH = ".github/workflows/engram-feeds.yml";

const NO_RUN: RunState = { feeds: {}, problem: null };
const UNREADABLE_STATE = "The feeds run cannot read feeds/state.json, so it is not checking any feed. Fix that file on GitHub.";

const STATUS_TEXT: Record<string, string> = {
  missing: "Not installed yet. Install the script, then add the workflow file.",
  partial: "Partly installed. One of the two files is missing.",
  outdated: "Installed, but out of date. Reinstall the script and paste the new workflow file.",
  current: "Installed and up to date.",
};

const FEED_STATUS_LABEL: Record<FeedStatus["kind"], string> = {
  new: "Not checked yet",
  waiting: "Waiting",
  due: "Due",
  paused: "Paused",
  failing: "Failing",
  working: "Working",
};

// The words used in the summary line, in the order they are shown.
const SUMMARY_WORDS: [FeedStatus["kind"], string][] = [
  ["failing", "failing"],
  ["paused", "paused"],
  ["due", "due"],
  ["waiting", "waiting"],
  ["new", "not checked yet"],
  ["working", "working"],
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// GitHub answers 409 or 422 when the file changed under us (stale sha).
function isConflict(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  return status === 409 || status === 422 || /\b(409|422)\b/.test(errorText(e));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// One line on what the status means for this feed. `runs` is false until the script and workflow are in place.
function detailOf(status: FeedStatus, runs: boolean): string {
  switch (status.kind) {
    case "new":
      return runs ? "The feeds run has not reached this feed yet." : "Nothing checks this feed until the workflow is set up (steps below).";
    case "waiting":
      return "The last run ran out of time before reaching this feed.";
    case "due":
      return "Its wait is over. It is tried on the next run.";
    case "paused":
      return `Engram is waiting until ${when(status.until)} before it asks again.`;
    case "failing":
      return `Last try failed: ${status.message}${status.since ? ` (since ${when(status.since)})` : ""}.`;
    case "working":
      return "No problems recorded.";
  }
}

// state.json is written by the Action. A missing file means no run has happened yet. A file the Action cannot read
// stops every run, so it is reported as such rather than shown as "not checked".
function readRunState(text: string | null): RunState {
  if (!text) return NO_RUN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { feeds: {}, problem: UNREADABLE_STATE };
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  const feeds = (parsed as { feeds?: unknown } | null)?.feeds;
  if (version !== 1 || !feeds || typeof feeds !== "object" || Array.isArray(feeds)) {
    return { feeds: {}, problem: UNREADABLE_STATE };
  }
  return { feeds: feeds as RunFeeds, problem: null };
}

export function FeedsCard({ folder }: { folder: Folder }) {
  const token = getAccount()?.token;
  const repo = folder.repo;
  const gh = useMemo(
    () => (token && repo ? new GitHub(token, repo) : null),
    // Rebuild only when the identity of the repo changes, not on every new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, repo?.owner, repo?.repo, repo?.branch],
  );
  const [file, setFile] = useState<Loaded | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>(NO_RUN);
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [addMessage, setAddMessage] = useState<AddMessage | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!gh) return;
    let live = true;
    (async () => {
      try {
        const [cfg, st] = await Promise.all([gh.getFile(CONFIG_PATH), gh.getFile(STATE_PATH)]);
        if (!live) return;
        // The list is set before the install check, so a failed check never hides the feeds.
        setFile({ data: parseFeedsJson(cfg?.text ?? null), sha: cfg?.sha });
        setFileProblem(checkFeedsText(cfg?.text ?? null));
        setRunState(readRunState(st?.text ?? null));
        const installed = await checkInstall(gh);
        if (live) setStatus(installed);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [gh]);

  // Re-reads the feeds file, so feeds followed from elsewhere show up in this list.
  async function reload() {
    if (!gh) return;
    try {
      const cfg = await gh.getFile(CONFIG_PATH);
      setFile({ data: parseFeedsJson(cfg?.text ?? null), sha: cfg?.sha });
      setFileProblem(checkFeedsText(cfg?.text ?? null));
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!gh || !repo) {
    return <p className="muted">Feeds need a folder that is synced to GitHub. Connect this folder first.</p>;
  }

  // One wrapper so every action shows a busy state and plain-text errors.
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Applies a change to feeds.json as it is on GitHub, so entries the change does not touch are written back exactly.
  // A file that is not valid JSON, or has no feeds list, is refused by the plan, so it is never written over. On a
  // stale sha it re-reads the file and tries once more. Returns why nothing was saved, or null when it was.
  async function writeFeeds(change: (text: string | null) => RawPlan): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await gh!.getFile(CONFIG_PATH);
      const plan = change(current?.text ?? null);
      if (!plan.ok) return plan.error;
      if (!plan.changed) {
        setFile({ data: parseFeedsJson(current?.text ?? null), sha: current?.sha });
        return null;
      }
      try {
        await gh!.putFile(CONFIG_PATH, plan.text, current?.sha, "Update feeds");
        // The save has happened, so a failed re-read only leaves the list showing the text that was just written.
        const fresh = await gh!.getFile(CONFIG_PATH).catch(() => null);
        setFile({ data: parseFeedsJson(fresh?.text ?? plan.text), sha: fresh?.sha });
        setFileProblem(checkFeedsText(fresh?.text ?? plan.text));
        return null;
      } catch (e) {
        if (attempt === 1 || !isConflict(e)) throw e;
      }
    }
    return "The feeds file kept changing. Try again.";
  }

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setAddMessage(null);
    void run(async () => {
      try {
        const problem = await writeFeeds((text) => planAddFeed(text, url, name.trim() || undefined));
        if (problem) {
          setAddMessage({ ok: false, text: problem });
          return;
        }
        setUrl("");
        setName("");
        // New entries only arrive once the script and workflow are in place, so say so until they are.
        setAddMessage({
          ok: true,
          text:
            status === "current"
              ? "Added. New entries reach your Inbox after the next scheduled run."
              : "Added. New entries reach your Inbox once the workflow is set up (steps below).",
        });
      } catch (err) {
        setAddMessage({ ok: false, text: errorText(err) });
      }
    });
  };

  const onRemove = (id: string) =>
    void run(async () => {
      const problem = await writeFeeds((text) => planRemoveFeed(text, id));
      if (problem) setError(problem);
    });

  const installScript = () =>
    void run(async () => {
      const script = FEED_INSTALL_FILES.find((f) => f.path === SCRIPT_PATH);
      if (!script) throw new Error("The script text is missing from this build.");
      await putFeedScript(gh!, SCRIPT_PATH, script.text);
      setStatus(await checkInstall(gh!));
      setNotice("Script installed. Now add the workflow file (see the steps below).");
    });

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setError(null);
      setNotice(`Copied ${label}.`);
    } catch {
      setError("Could not copy. Select the text and copy it by hand.");
    }
  }

  const feeds = file?.data.feeds ?? [];
  const full = feeds.length >= MAX_FEEDS;
  const runs = status === "current";
  const now = Date.now();
  const runFor = (id: string) => (Object.prototype.hasOwnProperty.call(runState.feeds, id) ? runState.feeds[id] : undefined);
  // Problems first, so a broken feed is not lost at the bottom of a long list.
  const rows = feeds
    .map((feed) => ({
      feed,
      label: feed.title || runFor(feed.id)?.title || hostOf(feed.url),
      status: feedStatus(runFor(feed.id), now),
    }))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.label.localeCompare(b.label));
  // The filter box only shows for long lists, so the filter only applies when it can be seen and cleared.
  const q = feeds.length > 8 ? filter.trim().toLowerCase() : "";
  const shown = q ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.feed.url.toLowerCase().includes(q)) : rows;
  const counts: Record<FeedStatus["kind"], number> = { new: 0, waiting: 0, due: 0, paused: 0, failing: 0, working: 0 };
  for (const r of rows) counts[r.status.kind]++;
  const summary = [
    `${feeds.length} of ${MAX_FEEDS} feeds`,
    ...SUMMARY_WORDS.filter(([k]) => counts[k] > 0).map(([k, word]) => `${counts[k]} ${word}`),
  ].join(" · ");
  const workflowText = FEED_INSTALL_FILES.find((f) => f.path === WORKFLOW_PATH)?.text ?? "";
  // GitHub fills in the file name and contents and the reader presses Commit. Engram can't add the file itself: that needs a permission it doesn't ask for.
  const newFileUrl = `https://github.com/${repo.owner}/${repo.repo}/new/${encodeURI(repo.branch)}?filename=${WORKFLOW_PATH}&value=${encodeURIComponent(workflowText)}`;

  return (
    <div>
      <h3>Feeds</h3>
      <p className="muted">
        A scheduled GitHub Action in your library folder's repo reads your feeds and drops new posts into your Inbox. You
        accept or dismiss them in the app.
      </p>

      {error && (
        <p role="alert" style={{ color: "var(--danger, #b3261c)" }}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <h4>Add a feed</h4>
      <form className="form" onSubmit={onAdd}>
        {full && (
          <p className="muted">
            You follow {MAX_FEEDS} feeds, the most Engram checks in one run. Remove a feed to add another.
          </p>
        )}
        <label>
          <span>Feed address</span>
          <input
            type="text"
            inputMode="url"
            required
            disabled={full || busy}
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          <span>Name (optional)</span>
          <input type="text" disabled={full || busy} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <footer>
          <button className="btn btn-primary" type="submit" disabled={busy || full || !url.trim()}>
            Add feed
          </button>
          {/* Always mounted, so a screen reader announces the message when its text changes. */}
          <span role="status" style={addMessage && !addMessage.ok ? { color: "var(--danger, #b3261c)" } : undefined}>
            {addMessage?.text}
          </span>
        </footer>
      </form>

      <h4>Your feeds</h4>
      {!file ? (
        <p className="muted">Loading feeds…</p>
      ) : (
        <>
          {fileProblem && (
            <p role="alert" style={{ color: "var(--danger, #b3261c)" }}>
              {fileProblem}
            </p>
          )}
          {runState.problem && (
            <p role="alert" style={{ color: "var(--danger, #b3261c)" }}>
              {runState.problem}
            </p>
          )}
          {feeds.length === 0 ? (
            !fileProblem && <p className="muted">No feeds yet.</p>
          ) : (
            <>
              <p className="muted">{summary}</p>
              {feeds.length > 8 && (
                <input
                  type="search"
                  className="feed-filter"
                  placeholder="Filter feeds"
                  aria-label="Filter feeds"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <ul className="feed-list">
                {shown.map(({ feed, label, status: feedState }) => (
                  <li key={feed.id} className="feed-row">
                    <div className="feed-main">
                      <strong className="feed-name">{label}</strong>
                      <span className="muted feed-url">{feed.url}</span>
                      <span className="muted feed-detail">{detailOf(feedState, runs)}</span>
                    </div>
                    <span className={`feed-status feed-status-${feedState.kind}`}>{FEED_STATUS_LABEL[feedState.kind]}</span>
                    <button
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => onRemove(feed.id)}
                      aria-label={`Remove ${label}, ${feed.url}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {shown.length === 0 && <p className="muted">No feeds match "{filter.trim()}".</p>}
            </>
          )}
        </>
      )}

      <FindFeeds onFollowed={() => void reload()} />

      <section className="setup-card">
        <h4>Step 1: install the script</h4>
        <p className="muted">{status ? (STATUS_TEXT[status] ?? String(status)) : "Checking…"}</p>
        <button className="btn" disabled={busy} onClick={installScript}>
          Install script
        </button>
      </section>

      <section className="setup-card">
        <h4>Step 2: add the workflow</h4>
        {status === "current" ? (
          <p className="muted">The workflow is in place.</p>
        ) : (
          <>
            <a className="btn btn-primary" href={newFileUrl} target="_blank" rel="noreferrer">
              Add workflow file on GitHub
            </a>
            <p className="muted">
              GitHub opens with the file already filled in. Press Commit changes there, then open the Actions tab and
              press Run workflow once.
            </p>
          </>
        )}
      </section>

      <details>
        <summary>Copy the workflow instead</summary>
        <p className="muted">Only if the button above doesn't open GitHub. The file goes at {WORKFLOW_PATH} in your repo.</p>
        {FEED_INSTALL_FILES.map((f) => (
          <div key={f.path}>
            <p>
              <code>{f.path}</code>{" "}
              <button className="btn" aria-label={`Copy ${f.path}`} onClick={() => void copy(f.text, f.path)}>
                Copy
              </button>
            </p>
            <pre
              role="region"
              aria-label={f.path}
              style={{ maxHeight: 240, overflow: "auto" }}
              // Read-only on purpose: users copy it, they do not edit it.
              tabIndex={0}
            >
              {f.text}
            </pre>
          </div>
        ))}
      </details>
    </div>
  );
}
