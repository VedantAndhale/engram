import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, ExternalLink, LoaderCircle, LogOut, Menu as MenuIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { anyPending, disconnectAccount, ensureRepos, hiddenFolders, restoreFolder, visibleFolders } from "../folders/registry";
import type { Folder } from "../model";
import { navigate, toast } from "../store/ui";
import { useAccount } from "../sync/account";
import { useGrantAccess } from "./grantaccess";
import { startSignIn } from "../sync/signin";
import { ConfirmDialog, GitHubMark, PrivateBadge, SyncDot, syncLabel, useFolderSync } from "./common";
import { FeedsCard } from "./FeedsCard";
import { AppInstallCard } from "./AppInstallCard";
import { useHabit } from "../habit/prefs";
import { chooseLibrary, libraryOf } from "../folders/library";

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
  const removed = useLiveQuery(hiddenFolders, []) ?? [];
  const [confirm, setConfirm] = useState<{ pending: boolean } | null>(null);
  const [fixing, setFixing] = useState(false);
  const libraryId = useHabit((h) => h.libraryId);
  const library = libraryOf(folders, libraryId);
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
      <AppInstallCard />
      <ul className="repo-list">
        {folders.map((f) => (
          <RepoRow key={f.id} folder={f} isLibrary={library?.id === f.id} />
        ))}
      </ul>
      {library && <FeedsCard key={library.id} folder={library} />}
      {library && <p className="hint">Feeds set up in other folders keep running there. To manage those here, make that folder the library.</p>}
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

      {removed.length > 0 && (
        <>
          <h2>Removed from this device</h2>
          <p className="hint">These folders are still in your GitHub account. Add one back to sync it here again.</p>
          <ul className="repo-list">
            {removed.map((f) => (
              <li key={f.id}>
                <span className="repo-folder">{f.name}</span>
                <span className="muted repo-link">
                  {f.repo!.owner}/{f.repo!.repo}
                </span>
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    await restoreFolder(f.id);
                    toast(`${f.name} is back. Its files are coming down from GitHub.`);
                  }}
                >
                  Add back
                </button>
              </li>
            ))}
          </ul>
        </>
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

function RepoRow({ folder, isLibrary }: { folder: Folder; isLibrary: boolean }) {
  const s = useFolderSync(folder.id);
  const access = useGrantAccess(folder, s.message);

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
      {isLibrary ? (
        <span className="muted repo-state">Articles and feeds go here</span>
      ) : (
        folder.repo && (
          <button className="btn btn-small" onClick={() => chooseLibrary(folder.id)}>
            Use for articles and feeds
          </button>
        )
      )}
      {access.needed && (
        <button className="btn btn-small" disabled={access.granting} onClick={() => void access.grant()}>
          {access.granting ? "Adding…" : "Give Engram access"}
        </button>
      )}
      {access.needed && access.problem && <span className="muted repo-state">{access.problem}</span>}
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
        <ShieldCheck size={13} /> GitHub will ask you to allow Engram read and write access to your repositories, including private ones, so it
        can create a private one for each folder and sync it. Engram's server handles the sign-in and records your GitHub login, name and
        primary email. Your token then
        stays in this browser and goes only to api.github.com, and to Engram's server to revoke it when you disconnect.
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
