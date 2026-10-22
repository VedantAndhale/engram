import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Menu as MenuIcon, Network } from "lucide-react";
import { useMemo } from "react";
import { itemHref } from "../capture/capture";
import { folderCtx } from "../folders/registry";
import { buildGraph, neighbourhood, type GItem, type Graph as GraphData } from "../graph/graph";
import type { Folder } from "../model";
import { navigate } from "../store/ui";
import { GraphCanvas } from "./GraphCanvas";
import "../styles/graph.css";

/** The items of a folder as the graph reads them. Items in the trash are left out. */
function useFolderItems(folder: string): GItem[] | undefined {
  return useLiveQuery(async () => {
    const rows: GItem[] = [];
    await folderCtx(folder).db.items.each((i) => {
      if (i.deleted) return;
      rows.push({ id: i.id, title: i.title, type: i.type, body: i.body, topics: i.topics });
    });
    return rows;
  }, [folder]);
}

const hrefIn = (folder: string, items: GItem[]) => (id: string) => {
  const it = items.find((i) => i.id === id);
  return it ? itemHref(folder, { id: it.id, type: it.type as never }) : "#/library";
};

const open = (folder: string, items: GItem[]) => (id: string) => {
  location.hash = hrefIn(folder, items)(id);
};

/** The whole folder as a graph: what links to what, and what shares a topic. */
export function Graph({ folder, onOpenSidebar }: { folder: Folder; onOpenSidebar: () => void }) {
  const items = useFolderItems(folder.id);
  const graph = useMemo<GraphData | null>(() => (items ? buildGraph(items) : null), [items]);
  const links = graph?.edges.filter((e) => e.kind === "link").length ?? 0;
  const count = graph?.nodes.filter((n) => n.kind === "item").length ?? 0;

  return (
    <main className="graph-page">
      <header className="topbar">
        <button className="icon-btn only-narrow" aria-label="Folders" onClick={onOpenSidebar}>
          <MenuIcon size={20} />
        </button>
        <button className="icon-btn" aria-label={`Back to ${folder.name}`} onClick={() => navigate({ name: "library", folder: folder.id })}>
          <ArrowLeft size={20} />
        </button>
        <h1>Graph</h1>
        <span className="muted">{folder.name}</span>
        <div className="spacer" />
      </header>

      {!graph ? null : count === 0 ? (
        <div className="empty">
          <Network size={40} strokeWidth={1.4} />
          <h2>Nothing to connect yet</h2>
          <p>Save a few things. Link one to another with [[Title]] in your own words, and tag them with topics. They show up here.</p>
        </div>
      ) : (
        <div className="graph-wrap">
          <p className="graph-hint">
            {count} {count === 1 ? "item" : "items"}, {links} {links === 1 ? "link" : "links"}.{graph.omitted ? ` ${graph.omitted} with the fewest lines are left out.` : ""} Press a dot to open it. Drag to move, scroll
            to zoom, double-click to reset.
          </p>
          <GraphCanvas graph={graph} height={Math.max(360, Math.round(window.innerHeight - 190))} onOpen={open(folder.id, items!)} hrefFor={hrefIn(folder.id, items!)} label={`Graph of ${folder.name}: ${count} items and ${links} links`} />
          <p className="graph-legend">
            <span className="dot" /> an item, bigger with more lines <span className="line" /> a link <span className="square" /> a topic two or more items share
          </p>
        </div>
      )}
    </main>
  );
}

/** This item and what it touches, small, for under its backlinks. Draws nothing for an item with no lines. */
export function LocalGraph({ folder, id }: { folder: string; id: string }) {
  const items = useFolderItems(folder);
  const local = useMemo(() => {
    if (!items) return null;
    const g = neighbourhood(buildGraph(items), id);
    return g.nodes.length > 1 ? g : null;
  }, [items, id]);
  if (!local || !items) return null;
  return (
    <section className="local-graph" aria-label="Connections">
      <h2>
        <Network size={15} /> Connections
      </h2>
      <GraphCanvas graph={local} focus={id} height={220} compact onOpen={open(folder, items)} hrefFor={hrefIn(folder, items)} label={`Connections of this item: ${local.nodes.length - 1} others`} />
    </section>
  );
}
