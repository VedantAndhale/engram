import { useEffect, useId, useMemo, useState } from "react";
import type { Folder } from "../model";
import { getAccount } from "../sync/account";
import { GitHub } from "../sync/github";
import { addFeed, parseFeedsJson, removeFeed, type FeedsFile } from "../feeds/config";
import { FEED_INSTALL_FILES, checkInstall } from "../feeds/install";

type Loaded = { data: FeedsFile; sha: string | undefined };
type StateFeeds = Record<string, { title?: string; lastError?: { message?: string } | null }>;
type Status = Awaited<ReturnType<typeof checkInstall>>;

const CONFIG_PATH = "feeds.json";
const SCRIPT_PATH = "feeds/action/fetch-feeds.mjs";
const WORKFLOW_PATH = ".github/workflows/engram-feeds.yml";

const STATUS_TEXT: Record<string, string> = {
  missing: "Not installed yet. Install the script, then add the workflow file.",
  partial: "Partly installed. One of the two files is missing.",
  outdated: "Installed, but out of date. Reinstall the script and paste the new workflow file.",
  current: "Installed and up to date.",
};

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

// state.json is written by the Action; a missing or broken file just means "no extra info".
function readState(text: string | null): StateFeeds {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.feeds === "object" && parsed.feeds ? parsed.feeds : {};
  } catch {
    return {};
  }
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
  const [stateFeeds, setStateFeeds] = useState<StateFeeds>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const urlId = useId();
  const nameId = useId();

  useEffect(() => {
    if (!gh) return;
    let live = true;
    (async () => {
      try {
        const [cfg, st] = await Promise.all([gh.getFile(CONFIG_PATH), gh.getFile("feeds/state.json")]);
        const installed = await checkInstall(gh);
        if (!live) return;
        setFile({ data: parseFeedsJson(cfg?.text ?? null), sha: cfg?.sha });
        setStateFeeds(readState(st?.text ?? null));
        setStatus(installed);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [gh]);

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

  // Applies a change and saves feeds.json. On a stale sha it re-reads the file and tries once more.
  async function writeFeeds(change: (f: FeedsFile) => FeedsFile | { error: string }): Promise<boolean> {
    let current: Loaded = file ?? { data: parseFeedsJson(null), sha: undefined };
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = change(current.data);
      if ("error" in next) {
        setError(next.error);
        return false;
      }
      try {
        await gh!.putFile(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", current.sha, "Update feeds");
        const fresh = await gh!.getFile(CONFIG_PATH);
        setFile({ data: fresh ? parseFeedsJson(fresh.text) : next, sha: fresh?.sha });
        return true;
      } catch (e) {
        if (attempt === 1 || !isConflict(e)) throw e;
        const fresh = await gh!.getFile(CONFIG_PATH);
        current = { data: parseFeedsJson(fresh?.text ?? null), sha: fresh?.sha };
      }
    }
    return false;
  }

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const ok = await writeFeeds((f) => addFeed(f, url, name.trim() || undefined));
      if (!ok) return;
      setUrl("");
      setName("");
      setNotice("Feed added. New entries reach your Inbox after the next scheduled run.");
    });
  };

  const onRemove = (id: string) => void run(async () => void (await writeFeeds((f) => removeFeed(f, id))));

  const installScript = () =>
    void run(async () => {
      const script = FEED_INSTALL_FILES.find((f) => f.path === SCRIPT_PATH);
      if (!script) throw new Error("The script text is missing from this build.");
      const existing = await gh!.getFile(SCRIPT_PATH);
      await gh!.putFile(SCRIPT_PATH, script.text, existing?.sha, "Install Engram feeds script");
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
  const newFileUrl = `https://github.com/${repo.owner}/${repo.repo}/new/${encodeURI(repo.branch)}?filename=${WORKFLOW_PATH}`;

  return (
    <div>
      <h3>Feeds</h3>
      <p className="muted">
        A scheduled GitHub Action in this folder's repo reads your feeds and drops new posts into your Inbox. You
        accept or dismiss them in the app.
      </p>

      {error && (
        <p role="alert" style={{ color: "var(--danger, #b3261c)" }}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      {!file ? (
        <p className="muted">Loading feeds…</p>
      ) : feeds.length === 0 ? (
        <p className="muted">No feeds yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {feeds.map((f) => {
            const label = f.title || stateFeeds[f.id]?.title || hostOf(f.url);
            const lastError = stateFeeds[f.id]?.lastError?.message;
            return (
              <li key={f.id} style={{ marginBottom: 12 }}>
                <strong>{label}</strong>
                <div className="muted">{f.url}</div>
                {lastError && <div className="muted">Last fetch failed: {lastError}</div>}
                <button className="btn" disabled={busy} onClick={() => onRemove(f.id)} aria-label={`Remove ${label}`}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={onAdd}>
        <div>
          <label htmlFor={urlId}>Feed address</label>
          <input
            id={urlId}
            type="url"
            required
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={nameId}>Name (optional)</label>
          <input id={nameId} type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || !url.trim()}>
          Add feed
        </button>
      </form>

      <h4>Action status</h4>
      <p>{status ? (STATUS_TEXT[status] ?? String(status)) : "Checking…"}</p>
      <button className="btn" disabled={busy} onClick={installScript}>
        Install script
      </button>

      <details>
        <summary>Show the workflow files</summary>
        <p className="muted">
          GitHub does not let apps create workflow files, so you add the workflow by hand. The script is installed by
          the button above.
        </p>
        <ol>
          <li>
            Open{" "}
            <a className="link" href={newFileUrl} target="_blank" rel="noreferrer">
              the new-file page in your repo
            </a>{" "}
            (the file name is already filled in).
          </li>
          <li>Copy the workflow below, paste it into the editor, and commit it to {repo.branch}.</li>
          <li>Open the Actions tab, pick "Engram feeds", and press Run workflow. After that it runs every 6 hours.</li>
        </ol>
        {FEED_INSTALL_FILES.map((f) => (
          <div key={f.path}>
            <p>
              <code>{f.path}</code>{" "}
              <button className="btn" onClick={() => void copy(f.text, f.path)}>
                Copy
              </button>
            </p>
            <pre
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