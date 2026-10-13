import { useLiveQuery } from "dexie-react-hooks";
import { FileText, Highlighter, LoaderCircle, Menu as MenuIcon, Search as SearchIcon, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { folderCtx, visibleFolders, type FolderHit } from "../folders/registry";
import type { ItemType } from "../model";
import { snippet, type SearchFilter } from "../search/index";
import { navigate } from "../store/ui";

interface Group {
  key: string;
  folder: string;
  folderName: string;
  doc: string;
  title: string;
  type: ItemType;
  hits: FolderHit[];
}

/** Kinds of thing to narrow a search to. Each covers the item types that read alike. */
const KINDS: { label: string; types: ItemType[] }[] = [
  { label: "PDFs", types: ["pdf"] },
  { label: "Articles", types: ["article"] },
  { label: "Posts", types: ["post", "tweet", "thread"] },
  { label: "Notes", types: ["note", "quote"] },
  { label: "Videos", types: ["video", "playlist"] },
  { label: "Links", types: ["bookmark"] },
];

const LIMIT = 60;

/**
 * Search every folder, then rank all the hits together before cutting the list, so the best
 * match is never the one left out.
 */
async function searchEverywhere(query: string, filter: SearchFilter): Promise<FolderHit[]> {
  const folders = await visibleFolders();
  const per = await Promise.all(
    folders.map(async (f) => (await folderCtx(f.id).search.search(query, LIMIT, filter)).map((h) => ({ ...h, folder: f.id }))),
  );
  return per.flat().sort((a, b) => b.score - a.score).slice(0, LIMIT * 2);
}

export function Search({ q, onOpenSidebar }: { q: string; onOpenSidebar: () => void }) {
  const [text, setText] = useState(q);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folders = useLiveQuery(visibleFolders, []);
  const [kind, setKind] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  // Every topic in use, most used first, to narrow by.
  const topics = useLiveQuery(async () => {
    const counts = new Map<string, number>();
    for (const f of await visibleFolders())
      for (const d of await folderCtx(f.id).db.items.toArray()) if (!d.deleted) for (const t of d.topics ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, []);
  const filtered = kind !== null || topic !== null;

  useEffect(() => input.current?.focus(), []);

  // Keep the address in step with the box, without a history entry per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) navigate({ name: "search", q: text || undefined }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [text, q]);

  useEffect(() => {
    const query = text.trim();
    if (!query) {
      setGroups(null);
      return;
    }
    let stale = false;
    setBusy(true);
    const t = setTimeout(async () => {
      const hits = await searchEverywhere(query, { types: KINDS.find((k) => k.label === kind)?.types, topic: topic ?? undefined });
      const names = new Map((folders ?? (await visibleFolders())).map((f) => [f.id, f.name]));
      const byDoc = new Map<string, Group>();
      for (const h of hits) {
        const key = `${h.folder}:${h.doc}`;
        let g = byDoc.get(key);
        if (!g) {
          const meta = await folderCtx(h.folder).db.items.get(h.doc);
          g = { key, folder: h.folder, folderName: names.get(h.folder) ?? "", doc: h.doc, title: meta?.title ?? "Untitled", type: meta?.type ?? "pdf", hits: [] };
          byDoc.set(key, g);
        }
        g.hits.push(h);
      }
      // Documents come in order of their best match; within one, highlights first, then by page.
      for (const g of byDoc.values()) g.hits.sort((a, b) => (a.kind === b.kind ? a.page - b.page : a.kind === "annotation" ? -1 : 1));
      if (stale) return;
      setGroups([...byDoc.values()]);
      setBusy(false);
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [text, folders, kind, topic]);

  const open = (h: FolderHit, type: ItemType) =>
    type === "pdf"
      ? navigate({ name: "reader", folder: h.folder, doc: h.doc, page: h.page, find: h.kind === "page" ? text.trim() : undefined })
      : navigate({ name: "item", folder: h.folder, item: h.doc });

  const many = (folders?.length ?? 0) > 1;
  const total = groups?.reduce((n, g) => n + g.hits.length, 0) ?? 0;

  return (
    <main className="search">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <label className="search-box">
          <SearchIcon size={18} className="muted" />
          <input
            ref={input}
            type="search"
            value={text}
            placeholder="Search everything you saved"
            aria-label="Search"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setText("");
              if (e.key === "Enter" && groups?.[0]) open(groups[0].hits[0], groups[0].type);
            }}
          />
          {busy ? (
            <LoaderCircle size={16} className="spin muted" />
          ) : (
            text && (
              <button className="icon-btn" aria-label="Clear" onClick={() => (setText(""), input.current?.focus())}>
                <X size={16} />
              </button>
            )
          )}
        </label>
      </header>

      <div className="chips" role="group" aria-label="Narrow the search" style={{ padding: "8px 24px 0", maxWidth: 760 }}>
        {KINDS.map((k) => (
          <button key={k.label} className={`chip ${kind === k.label ? "on" : ""}`} aria-pressed={kind === k.label} onClick={() => setKind(kind === k.label ? null : k.label)}>
            {k.label}
          </button>
        ))}
        {(topics?.length ?? 0) > 0 && (
          <select className="chip" aria-label="Topic" value={topic ?? ""} onChange={(e) => setTopic(e.target.value || null)}>
            <option value="">Any topic</option>
            {topics!.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>

      {groups === null ? (
        <div className="empty">
          <SearchIcon size={40} strokeWidth={1.4} />
          <h2>Search your library</h2>
          <p>Finds titles, words in every PDF and saved article, and your highlights and notes{many ? ", across all folders" : ""}. Close spellings count too.</p>
        </div>
      ) : groups.length === 0 ? (
        !busy && (
          <div className="empty">
            <h2>No matches</h2>
            <p>Nothing matches “{text.trim()}”{filtered ? " with these filters" : ""}. Text in a newly added PDF can take a moment to index.</p>
            {filtered && (
              <button
                className="btn"
                onClick={() => {
                  setKind(null);
                  setTopic(null);
                }}
              >
                Search without filters
              </button>
            )}
          </div>
        )
      ) : (
        <div className="results">
          <p className="hint">
            {total} {total === 1 ? "match" : "matches"} in {groups.length} {groups.length === 1 ? "document" : "documents"}
          </p>
          {groups.map((g) => (
            <section key={g.key} className="result-group">
              <h2>
                <FileText size={16} className="muted" />
                <span className="result-title">{g.title}</span>
                {many && <span className="result-folder">{g.folderName}</span>}
              </h2>
              <ul>
                {g.hits.map((h) => (
                  <li key={h.id}>
                    <button className="result" onClick={() => open(h, g.type)}>
                      {h.kind === "annotation" ? (
                        <span className="result-kind" style={{ color: h.color }} title="Highlight">
                          <Highlighter size={14} />
                        </span>
                      ) : (
                        <span className="result-kind muted">{h.page > 0 ? `p.${h.page}` : <FileText size={14} />}</span>
                      )}
                      <span className="result-text">
                        <Marked text={h.kind === "page" ? snippet(h.text, [text.trim(), ...h.terms]) : h.text} terms={h.terms} />
                      </span>
                      {h.kind === "annotation" && h.page > 0 && <span className="result-page muted">p.{h.page}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function Marked({ text, terms }: { text: string; terms: string[] }) {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}
