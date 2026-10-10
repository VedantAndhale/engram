import { useLiveQuery } from "dexie-react-hooks";
import { Bot, Check, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import type { InboxRow } from "../db/db";
import { folderCtx, visibleFolders } from "../folders/registry";
import { timeAgo } from "../lib/util";
import { acceptInbox, dismissInbox } from "../store/inbox";
import { navigate, toast } from "../store/ui";

/** "From your agents" on Today: what agents sent through MCP, waiting for a yes or no. Hidden when empty. */
export function AgentInbox() {
  const rows = useLiveQuery(async () => {
    const out: { folder: string; folderName: string; row: InboxRow }[] = [];
    for (const f of await visibleFolders()) {
      for (const row of await folderCtx(f.id).db.inbox.toArray()) if (!row.resolved) out.push({ folder: f.id, folderName: f.name, row });
    }
    return out.sort((a, b) => b.row.entry.createdAt - a.row.entry.createdAt);
  }, []);
  if (!rows?.length) return null;
  const many = new Set(rows.map((r) => r.folder)).size > 1;

  return (
    <section className="today-card agent-inbox" aria-label="From your agents">
      <h2>
        <Bot size={17} /> From your agents
      </h2>
      <ul className="inbox-list">
        {rows.map((r) => (
          <InboxEntryRow key={`${r.folder} ${r.row.path}`} folder={r.folder} folderName={many ? r.folderName : undefined} row={r.row} />
        ))}
      </ul>
    </section>
  );
}

function InboxEntryRow({ folder, folderName, row }: { folder: string; folderName?: string; row: InboxRow }) {
  const e = row.entry;
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <li className="inbox-entry">
      <p className="inbox-what">
        {e.kind === "note" ? (
          <>
            A note for <strong>{e.targetTitle ?? "an item"}</strong>
          </>
        ) : (
          <strong>{e.title ?? e.sourceUrl ?? "Something to keep"}</strong>
        )}
        {e.sourceUrl && (
          <a className="muted" href={e.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open the link">
            <ExternalLink size={12} />
          </a>
        )}
      </p>
      {e.why && <p className="inbox-why">{e.why}</p>}
      {e.text && <p className="inbox-text">{e.text.length > 280 ? `${e.text.slice(0, 280)}…` : e.text}</p>}
      <p className="muted inbox-meta">
        {e.agent} · {timeAgo(e.createdAt)}
        {folderName ? ` · ${folderName}` : ""}
        {e.content ? " · includes saved text" : ""}
      </p>
      <div className="inbox-actions">
        <button
          className="btn btn-small btn-primary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const { item } = await acceptInbox(folder, row);
              toast(e.kind === "note" ? "Note added." : "Saved.", { action: { label: "Open", run: () => navigate({ name: "item", folder, item }) } });
            })
          }
        >
          <Check size={14} /> {e.kind === "note" ? "Add note" : "Save"}
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => act(() => dismissInbox(folder, row))}>
          <X size={14} /> Dismiss
        </button>
      </div>
    </li>
  );
}
