import { AlertTriangle, Check, CloudOff, LoaderCircle, Lock, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { timeAgo } from "../lib/util";
import { dismissToast, useUI } from "../store/ui";
import { useSync, type FolderSync } from "../sync/engine";

// ---------------------------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------------------------

export function useFolderSync(id: string | undefined): FolderSync {
  return useSync((s) => (id ? s.folders[id] : undefined)) ?? { state: "local", pending: 0 };
}

export function syncLabel(s: FolderSync): string {
  switch (s.state) {
    case "local":
      return "On this device only";
    case "synced":
      return s.lastSyncedAt ? `Synced ${timeAgo(s.lastSyncedAt)}` : "Synced";
    case "syncing":
      return "Syncing…";
    case "pending":
      return `${s.pending} change${s.pending === 1 ? "" : "s"} waiting`;
    case "offline":
      return "Offline: changes are saved here";
    case "auth":
      return "GitHub sign-in needed";
    case "error":
      return "Sync problem";
  }
}

/** A small dot for the folder list; the badge in the top bar adds words. */
export function SyncDot({ s }: { s: FolderSync }) {
  return <span className={`sync-dot sync-${s.state}`} title={s.message ?? syncLabel(s)} />;
}

export function SyncBadge({ s, onClick }: { s: FolderSync; onClick?: () => void }) {
  const icon =
    s.state === "syncing" ? (
      <LoaderCircle size={14} className="spin" />
    ) : s.state === "synced" ? (
      <Check size={14} />
    ) : s.state === "offline" || s.state === "local" ? (
      <CloudOff size={14} />
    ) : s.state === "error" || s.state === "auth" ? (
      <AlertTriangle size={14} />
    ) : (
      <LoaderCircle size={14} />
    );
  return (
    <button className={`sync-badge sync-${s.state}`} title={s.message ?? syncLabel(s)} onClick={onClick}>
      {icon}
      <span>{syncLabel(s)}</span>
    </button>
  );
}

export function PrivateBadge({ isPrivate }: { isPrivate?: boolean }) {
  if (isPrivate === false)
    return (
      <span className="badge badge-warn" title="Anyone can see this repository. Make it private on GitHub.">
        <AlertTriangle size={12} /> Public repo
      </span>
    );
  return (
    <span className="badge" title="Private repository">
      <Lock size={12} /> Private
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

/** What Tab can reach inside an element, in order. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.closest("[inert]") && x.getClientRects().length > 0);
}

/**
 * Keeps keyboard focus inside a dialog while it is open: focus moves in when it opens (unless a
 * field in it already took it), Tab and Shift+Tab go round inside it, and when it closes focus
 * goes back to what had it before, so you don't lose your place.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A dialog opened from a menu goes back to the button that opened the menu.
    const active = document.activeElement as HTMLElement | null;
    const before = active && active !== document.body && active.isConnected ? active : lastMenuAnchor;
    lastMenuAnchor = null;
    if (!el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const all = focusables(el);
      if (!all.length) return e.preventDefault();
      const first = all[0];
      const last = all[all.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // After the dialog is gone, unless whatever closed it moved focus somewhere on purpose.
      setTimeout(() => {
        const now = document.activeElement;
        if (before?.isConnected && (!now || now === document.body || !now.isConnected)) before.focus();
      }, 0);
    };
  }, [ref]);
}

/**
 * `top` pins the dialog under the top of the window instead of centring it, for a dialog whose
 * height changes as it runs: centred, it would slide up and down with every change.
 */
export function Modal({ title, onClose, children, wide, top }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; top?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={`modal-backdrop ${top ? "modal-top" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Ask for one line of text. `submit` may throw; its message is shown under the field. */
export function PromptDialog({
  title,
  label,
  initial = "",
  placeholder,
  action,
  hint,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  action: string;
  hint?: ReactNode;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          <span>{label}</span>
          <input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        {hint && <p className="hint">{hint}</p>}
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim() || busy}>
            {busy && <LoaderCircle size={14} className="spin" />} {action}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  children,
  action,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  action: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        {children}
        <footer>
          {/* Something that can't be undone starts on Cancel, so one keystroke never confirms it. */}
          <button className="btn" autoFocus={danger} onClick={onClose}>
            Cancel
          </button>
          <button
            autoFocus={!danger}
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                onClose();
              }
            }}
          >
            {action}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** The button that opened the menu last closed, for a dialog that menu opened to return to. */
let lastMenuAnchor: HTMLElement | null = null;

/** A popover menu anchored to the element that opened it: under its right edge, or its left with `align="start"`. */
export function Menu({
  anchor,
  items,
  onClose,
  align = "end",
}: {
  anchor: HTMLElement;
  items: MenuItem[];
  /** `away` is the target of a press outside the menu; no reason for Escape, a pick, or a resize. */
  onClose: (reason?: { away: EventTarget | null }) => void;
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const m = ref.current!.getBoundingClientRect();
    const left = Math.min(align === "start" ? a.left : a.right - m.width, window.innerWidth - m.width - 8);
    const below = a.bottom + 4 + m.height < window.innerHeight;
    setPos({ top: below ? a.bottom + 4 : a.top - m.height - 4, left: Math.max(8, left) });
  }, [anchor, align]);
  // Closing puts focus back on what opened the menu, unless a click elsewhere or a pick moved it on purpose.
  useEffect(
    () => () => {
      lastMenuAnchor = anchor;
      setTimeout(() => {
        const now = document.activeElement;
        if (anchor.isConnected && (!now || now === document.body || !now.isConnected)) anchor.focus();
      }, 0);
    },
    [anchor],
  );
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose({ away: e.target });
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onResize = () => onClose();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose]);
  // Keyboard: the first item takes focus; Up and Down move between items.
  useEffect(() => ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(), []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <div ref={ref} className="menu" role="menu" style={pos} onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? "danger" : ""}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/** State for a menu that opens from a button: `open(e)` with the click event, `node` to render. */
export function useMenu() {
  const [state, setState] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  return {
    open: (e: React.MouseEvent, items: MenuItem[]) => {
      e.stopPropagation();
      e.preventDefault();
      setState({ anchor: e.currentTarget as HTMLElement, items });
    },
    node: state && <Menu anchor={state.anchor} items={state.items} onClose={() => setState(null)} />,
  };
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** GitHub's mark (lucide no longer ships brand icons). */
export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
