import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, ExternalLink, KeyRound, LoaderCircle, LogOut, Menu as MenuIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { anyPending, connectAccount, disconnectAccount, ensureRepos, visibleFolders, type ConnectResult } from "../folders/registry";
import type { Folder } from "../model";
import { navigate, toast } from "../store/ui";
import { useAccount } from "../sync/account";
import { ConfirmDialog, GitHubMark, PrivateBadge, SyncDot, syncLabel, useFolderSync } from "./common";

type Kind = "classic" | "fine-grained";

const TOKEN_URL: Record<Kind, string> = {
  classic: "https://github.com/settings/tokens/new?scopes=repo&description=Engram",
  "fine-grained": "https://github.com/settings/personal-access-tokens/new",
};

export function Setup({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const { account, authError } = useAccount();
  const [replacing, setReplacing] = useState(false);
  const showForm = !account || authError || replacing;

  return (
    <main className="setup">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <h1>GitHub</h1>
      </header>
      <div className="setup-body">
        {account && !authError && <AccountCard onReplace={() => setReplacing(true)} />}
        {authError && (
          <p className="banner banner-warn">
            <AlertTriangle size={16} /> GitHub stopped accepting your token. It may have expired or been revoked. Paste a new one below;
            your changes are kept on this device until then.
          </p>
        )}
        {showForm && <TokenForm replacing={!!account} onDone={() => setReplacing(false)} />}
      </div>
    </main>
  );
}

function AccountCard({ onReplace }: { onReplace: () => void }) {
  const account = useAccount((a) => a.account)!;
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const [confirm, setConfirm] = useState<{ pending: boolean } | null>(null);
  const [fixing, setFixing] = useState(false);
  const missing = folders.filter((f) => !f.repo).length;

  return (
    <section className="setup-card">
      <div className="account-row">
        {account.avatarUrl ? <img className="avatar-lg" src={account.avatarUrl} alt="" /> : <GitHubMark size={40} />}
        <div className="account-who">
          <strong>{account.name ?? account.login}</strong>
          <span className="muted">
            @{account.login} · {account.tokenKind === "fine-grained" ? "fine-grained token" : account.tokenKind === "classic" ? "classic token" : "token"}
          </span>
        </div>
        <button className="btn btn-small" onClick={onReplace}>
          <KeyRound size={14} /> Replace token
        </button>
        <button className="btn btn-small" onClick={async () => setConfirm({ pending: await anyPending() })}>
          <LogOut size={14} /> Disconnect
        </button>
      </div>

      <h2>Folders</h2>
      <p className="hint">Each folder syncs to its own private repository.</p>
      <ul className="repo-list">
        {folders.map((f) => (
          <RepoRow key={f.id} folder={f} />
        ))}
      </ul>
      {missing > 0 && (
        <button
          className="btn btn-small"
          disabled={fixing}
          onClick={async () => {
            setFixing(true);
            const problem = await ensureRepos();
            setFixing(false);
            toast(problem ?? "Repositories created.");
          }}
        >
          {fixing && <LoaderCircle size={14} className="spin" />} Create {missing === 1 ? "the missing repository" : `${missing} missing repositories`}
        </button>
      )}

      {confirm && (
        <ConfirmDialog
          title="Disconnect GitHub?"
          action="Disconnect"
          danger={confirm.pending}
          onConfirm={async () => {
            await disconnectAccount();
            toast("Disconnected. Your folders stay on this device.");
          }}
          onClose={() => setConfirm(null)}
        >
          <p>The token is removed from this device. Folders, PDFs and highlights stay here, and your repositories stay on GitHub.</p>
          {confirm.pending && (
            <p className="error">Some changes haven't reached GitHub yet. They'll stay on this device and upload when you connect again.</p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

function RepoRow({ folder }: { folder: Folder }) {
  const s = useFolderSync(folder.id);
  return (
    <li>
      <SyncDot s={s} />
      <button className="repo-folder" onClick={() => navigate({ name: "library", folder: folder.id })}>
        {folder.name}
      </button>
      {folder.repo ? (
        <>
          <PrivateBadge isPrivate={folder.isPrivate} />
          <a className="repo-link muted" href={`https://github.com/${folder.repo.owner}/${folder.repo.repo}`} target="_blank" rel="noreferrer">
            {folder.repo.owner}/{folder.repo.repo} <ExternalLink size={12} />
          </a>
        </>
      ) : (
        <span className="muted repo-link">No repository yet</span>
      )}
      <span className="muted repo-state">{s.message ?? syncLabel(s)}</span>
    </li>
  );
}

function TokenForm({ replacing, onDone }: { replacing: boolean; onDone: () => void }) {
  const [kind, setKind] = useState<Kind>("classic");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectResult | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await connectAccount(token);
      setToken("");
      setResult(r);
      if (!r.repoProblem) {
        toast(`Connected as ${r.login}.`);
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (result?.repoProblem)
    return (
      <section className="setup-card">
        <p className="banner banner-warn">
          <AlertTriangle size={16} /> Connected as {result.login}, but folders can't get repositories yet.
        </p>
        <p>{result.repoProblem}</p>
        <p className="hint">After changing the token on GitHub, paste it again here. Nothing is lost meanwhile.</p>
        <footer className="setup-actions">
          <button className="btn btn-primary" onClick={() => setResult(null)}>
            Paste token again
          </button>
          <button className="btn" onClick={onDone}>
            Later
          </button>
        </footer>
      </section>
    );

  return (
    <section className="setup-card">
      {!replacing && (
        <>
          <h2>Sync with GitHub</h2>
          <p>
            Engram keeps each folder in its own private GitHub repository, so your PDFs, highlights and notes are on every device you
            connect. You need a GitHub account and a personal access token.
          </p>
        </>
      )}

      <div className="segmented" role="tablist" aria-label="Token type">
        <button role="tab" aria-selected={kind === "classic"} className={kind === "classic" ? "active" : ""} onClick={() => setKind("classic")}>
          Classic token
        </button>
        <button
          role="tab"
          aria-selected={kind === "fine-grained"}
          className={kind === "fine-grained" ? "active" : ""}
          onClick={() => setKind("fine-grained")}
        >
          Fine-grained token
        </button>
      </div>

      {kind === "classic" ? (
        <ol className="steps">
          <li>
            Open{" "}
            <a href={TOKEN_URL.classic} target="_blank" rel="noreferrer">
              New classic token <ExternalLink size={12} />
            </a>
            . The <code>repo</code> scope is already ticked.
          </li>
          <li>Pick an expiration. When it runs out, Reader asks for a new token and keeps your changes until then.</li>
          <li>Click <strong>Generate token</strong> and copy it (it starts with <code>ghp_</code>).</li>
        </ol>
      ) : (
        <ol className="steps">
          <li>
            Open{" "}
            <a href={TOKEN_URL["fine-grained"]} target="_blank" rel="noreferrer">
              New fine-grained token <ExternalLink size={12} />
            </a>
            .
          </li>
          <li>
            Under <strong>Repository access</strong>, choose <strong>All repositories</strong>, so Reader can create a repository for each new
            folder.
          </li>
          <li>
            Under <strong>Permissions</strong>, set <strong>Administration</strong> and <strong>Contents</strong> to <em>Read and write</em>.
          </li>
          <li>Generate the token and copy it (it starts with <code>github_pat_</code>).</li>
        </ol>
      )}
      {kind === "fine-grained" && (
        <p className="hint">Fine-grained tokens only reach repositories you own. To open folders others share with you, use a classic token.</p>
      )}

      <form className="form setup-form" onSubmit={submit}>
        <label>
          <span>Token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder={kind === "classic" ? "ghp_…" : "github_pat_…"}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          <ShieldCheck size={13} /> The token is stored only in this browser and sent only to api.github.com.
        </p>
        <footer>
          {replacing && (
            <button type="button" className="btn" onClick={onDone}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!token.trim() || busy}>
            {busy && <LoaderCircle size={14} className="spin" />} {busy ? "Connecting…" : replacing ? "Use this token" : "Connect"}
          </button>
        </footer>
      </form>
    </section>
  );
}
