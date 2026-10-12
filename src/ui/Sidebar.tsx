import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, ExternalLink, FolderPlus, Highlighter, Moon, Pencil, Search, Sun, Sunrise, Trash2, Coffee, Ellipsis, Command } from "lucide-react";
import { useState } from "react";
import {
  createFolder,
  pendingChanges,
  removeFolder,
  renameFolder,
  RepoPermissionError,
  visibleFolders,
} from "../folders/registry";
import type { Folder } from "../model";
import { navigate, openPalette, setTheme, toast, useUI, type Theme } from "../store/ui";
import { useAccount } from "../sync/account";
import { ConfirmDialog, GitHubMark, PromptDialog, SyncDot, useFolderSync, useMenu } from "./common";

/** The key Go to anything is under: Cmd on a Mac, Ctrl elsewhere. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

const NEXT_THEME: Record<Theme, Theme> = { light: "sepia", sepia: "dark", dark: "light" };

type Dialog = { kind: "new" } | { kind: "rename"; folder: Folder } | { kind: "remove"; folder: Folder; pending: number };

export function Sidebar({ active, onNavigate }: { active?: string; onNavigate?: () => void }) {
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const { account, authError } = useAccount();
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const menu = useMenu();

  const go = (folder: string) => {
    navigate({ name: "library", folder });
    onNavigate?.();
  };

  const folderMenu = (e: React.MouseEvent, f: Folder) =>
    menu.open(e, [
      { label: "Rename", icon: <Pencil size={15} />, run: () => setDialog({ kind: "rename", folder: f }) },
      ...(f.repo
        ? [
            {
              label: "Open repository on GitHub",
              icon: <ExternalLink size={15} />,
              run: () => window.open(`https://github.com/${f.repo!.owner}/${f.repo!.repo}`, "_blank", "noopener"),
            },
          ]
        : []),
      {
        label: "Remove from this device",
        icon: <Trash2 size={15} />,
        danger: true,
        run: async () => setDialog({ kind: "remove", folder: f, pending: await pendingChanges(f.id) }),
      },
    ]);

  return (
    <nav className="sidebar">
      <div className="brand">
        <img src="./icon.svg" alt="" width={22} height={22} />
        <span>Engram</span>
      </div>

      <button
        className={`nav-item ${route.name === "today" ? "active" : ""}`}
        onClick={() => {
          navigate({ name: "today" });
          onNavigate?.();
        }}
      >
        <Sunrise size={16} />
        <span>Today</span>
      </button>

      <button
        className={`nav-item ${route.name === "highlights" ? "active" : ""}`}
        onClick={() => {
          navigate({ name: "highlights" });
          onNavigate?.();
        }}
      >
        <Highlighter size={16} />
        <span>Highlights</span>
      </button>

      <button
        className={`nav-item ${route.name === "search" ? "active" : ""}`}
        onClick={() => {
          navigate({ name: "search" });
          onNavigate?.();
        }}
      >
        <Search size={16} />
        <span>Search</span>
        <kbd>/</kbd>
      </button>

      <button
        className="nav-item"
        onClick={() => {
          openPalette();
          onNavigate?.();
        }}
      >
        <Command size={16} />
        <span>Go to anything</span>
        <kbd>{MOD}K</kbd>
      </button>

      <div className="nav-section">
        <span>Folders</span>
        <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => setDialog({ kind: "new" })}>
          <FolderPlus size={16} />
        </button>
      </div>
      <ul className="folder-list">
        {folders.map((f) => (
          <FolderRow key={f.id} folder={f} active={f.id === active} onOpen={() => go(f.id)} onMenu={(e) => folderMenu(e, f)} />
        ))}
      </ul>

      <div className="sidebar-foot">
        {authError && (
          <button className="nav-item warn" onClick={() => navigate({ name: "setup" })}>
            <AlertTriangle size={16} />
            <span>Sign in to GitHub again</span>
          </button>
        )}
        <button className={`nav-item ${route.name === "setup" ? "active" : ""}`} onClick={() => navigate({ name: "setup" })}>
          {account?.avatarUrl ? <img className="avatar" src={account.avatarUrl} alt="" /> : <GitHubMark />}
          <span>{account ? account.login : "Connect GitHub"}</span>
        </button>
        <button className="nav-item" onClick={() => setTheme(NEXT_THEME[theme])} title="Change theme">
          {theme === "light" ? <Sun size={16} /> : theme === "sepia" ? <Coffee size={16} /> : <Moon size={16} />}
          <span>{theme === "light" ? "Light" : theme === "sepia" ? "Sepia" : "Dark"}</span>
        </button>
      </div>

      {menu.node}

      {dialog?.kind === "new" && (
        <PromptDialog
          title="New folder"
          label="Name"
          placeholder="e.g. Papers to read"
          action="Create"
          hint={account ? "It gets its own private GitHub repository." : "It stays on this device until you connect GitHub."}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            try {
              const f = await createFolder(name);
              go(f.id);
            } catch (e) {
              // The folder exists locally either way; the repository is retried in the background.
              if (e instanceof RepoPermissionError) toast(e.message, { ttl: 12_000 });
              else toast("Folder created. Its repository will be made when GitHub is reachable.");
              const f = (await visibleFolders()).find((x) => x.name === name.trim() && !x.repo);
              if (f) go(f.id);
            }
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog
          title="Rename folder"
          label="Name"
          initial={dialog.folder.name}
          action="Rename"
          hint="The repository keeps its name on GitHub; every device shows the new one."
          onClose={() => setDialog(null)}
          onSubmit={(name) => renameFolder(dialog.folder.id, name)}
        />
      )}
      {dialog?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove "${dialog.folder.name}"?`}
          action="Remove from this device"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const wasActive = dialog.folder.id === active;
            await removeFolder(dialog.folder.id);
            if (wasActive) navigate({ name: "library" });
          }}
        >
          {dialog.folder.repo ? (
            <p>
              Its files and notes stay in the private repository{" "}
              <strong>
                {dialog.folder.repo.owner}/{dialog.folder.repo.repo}
              </strong>
              .
            </p>
          ) : (
            <p>This folder has no repository yet, so its documents and notes will be deleted.</p>
          )}
          {dialog.pending > 0 && (
            <p className="error">
              {dialog.pending} change{dialog.pending === 1 ? " hasn't" : "s haven't"} reached GitHub yet and will be lost.
            </p>
          )}
        </ConfirmDialog>
      )}
    </nav>
  );
}

function FolderRow({ folder, active, onOpen, onMenu }: { folder: Folder; active: boolean; onOpen: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const s = useFolderSync(folder.id);
  return (
    <li className={`folder-row ${active ? "active" : ""}`}>
      <button className="nav-item" onClick={onOpen} onContextMenu={onMenu}>
        <SyncDot s={s} />
        <span className="folder-name">{folder.name}</span>
        {folder.isPrivate === false && <AlertTriangle size={14} className="warn-icon" aria-label="Public repository" />}
      </button>
      <button className="icon-btn row-menu" aria-label={`${folder.name} options`} onClick={onMenu}>
        <Ellipsis size={16} />
      </button>
    </li>
  );
}
