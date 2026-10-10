import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, ExternalLink, LoaderCircle, LogOut, Menu as MenuIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { anyPending, disconnectAccount, ensureRepos, visibleFolders } from "../folders/registry";
import type { Folder } from "../model";
import { navigate, toast } from "../store/ui";
import { useAccount } from "../sync/account";
import { startSignIn } from "../sync/signin";
import { ConfirmDialog, GitHubMark, PrivateBadge, SyncDot, syncLabel, useFolderSync } from "./common";

export function Setup({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const { account, authError, legacyToken, signIn } = useAccount();
  const signedIn = account && !authError;

  return (
    <main className="setup">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <h1>GitHub</h1>
      </header>
      <div className="setup-body">
        {signIn?.state === "repoProblem" && <RepoProblem login={signIn.login} message={signIn.message} />}
        {signedIn && <AccountCard />}
        {authError && (
          <p className="banner banner-warn">
            <AlertTriangle size={16} /> GitHub stopped accepting Engram's sign-in. It may have been revoked. Sign in again; your changes
            are kept on this device until then.
          </p>
        )}
        {legacyToken && !account && (
          <p className="banner banner-warn">
            <AlertTriangle size={16} /> Engram now uses Sign in with GitHub instead of access tokens. Sign in once more; changes waiting on
            this device upload right after. You can delete the old token in GitHub's settings.
          </p>
        )}
        {!signedIn && <SignInCard again={!!account || legacyToken} />}
      </div>
    </main>
  );
}

function AccountCard() {
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
          <span className="muted">@{account.login} · signed in with GitHub</span>
        </div>
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
          <p>Your sign-in is removed from this device. Folders, PDFs and highlights stay here, and your repositories stay on GitHub.</p>
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

function RepoProblem({ login, message }: { login: string; message: string }) {
  return (
    <section className="setup-card">
      <p className="banner banner-warn">
        <AlertTriangle size={16} /> Signed in as {login}, but folders can't get repositories yet.
      </p>
      <p>{message}</p>
      <p className="hint">Nothing is lost meanwhile.</p>
      <footer className="setup-actions">
        <button className="btn btn-primary" onClick={startSignIn}>
          Sign in again
        </button>
        <button className="btn" onClick={() => useAccount.setState({ signIn: null })}>
          Later
        </button>
      </footer>
    </section>
  );
}

function SignInCard({ again }: { again: boolean }) {
  const signIn = useAccount((a) => a.signIn);
  const [leaving, setLeaving] = useState(false);
  const busy = leaving || signIn?.state === "busy";

  return (
    <section className="setup-card">
      {!again && (
        <>
          <h2>Sync with GitHub</h2>
          <p>
            Engram keeps each folder in its own private GitHub repository, so your PDFs, highlights and notes are on every device you
            connect. All you need is a GitHub account.
          </p>
        </>
      )}
      {signIn?.state === "error" && <p className="error">{signIn.message}</p>}
      <p className="hint">
        <ShieldCheck size={13} /> GitHub asks you to let Engram use your repositories, so it can create a private one for each folder and
        sync it. Your sign-in stays in this browser and is sent only to api.github.com.
      </p>
      <footer className="setup-actions">
        <button
          className="btn btn-primary"
          disabled={busy || !navigator.onLine}
          onClick={() => {
            setLeaving(true);
            startSignIn();
          }}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : <GitHubMark size={14} />}{" "}
          {signIn?.state === "busy" ? "Connecting…" : again ? "Sign in again" : "Sign in with GitHub"}
        </button>
      </footer>
    </section>
  );
}
