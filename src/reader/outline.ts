import type { PDFDoc } from "../lib/pdf";

/** One entry of a PDF's table of contents, flattened in reading order. */
export interface OutlineEntry {
  title: string;
  /** How deeply the entry is nested: 0 for the top level. */
  depth: number;
  /** 1-based page the entry opens at. */
  page: number;
}

type Outline = Awaited<ReturnType<PDFDoc["getOutline"]>>;

/**
 * The PDF's own table of contents (its bookmarks), flattened. An entry whose destination can't be
 * resolved is left out, so one broken bookmark doesn't hide the rest.
 */
export async function loadOutline(pdf: PDFDoc): Promise<OutlineEntry[]> {
  let nodes: Outline;
  try {
    nodes = await pdf.getOutline();
  } catch {
    return []; // A damaged outline must not stop the document from opening.
  }
  // pdf.js is typed to return an array, but it returns null for a document with no outline.
  if (!nodes) return [];

  // Flatten first, then resolve every destination at once: each one is a round trip to the worker,
  // and a long outline would otherwise delay the document's first page.
  const flat: { title: string; depth: number; dest: string | unknown[] | null }[] = [];
  const walk = (list: Outline, depth: number) => {
    for (const node of list) {
      flat.push({ title: node.title, depth, dest: node.dest });
      if (node.items?.length) walk(node.items, depth + 1);
    }
  };
  walk(nodes, 0);

  const pages = await Promise.all(flat.map((e) => pageOf(pdf, e.dest)));
  const entries: OutlineEntry[] = [];
  flat.forEach((e, i) => {
    const page = pages[i];
    if (page) entries.push({ title: e.title.trim() || `Page ${page}`, depth: e.depth, page });
  });
  return entries;
}

/** The 1-based page a destination opens at, or undefined when it can't be resolved. */
async function pageOf(pdf: PDFDoc, dest: string | unknown[] | null): Promise<number | undefined> {
  try {
    // A name is looked up first. Either way the destination array starts with the page's reference.
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : undefined;
    return ref ? (await pdf.getPageIndex(ref)) + 1 : undefined;
  } catch {
    return undefined;
  }
}
