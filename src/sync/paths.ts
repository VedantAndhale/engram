/**
 * Repository layout. Each item is one Markdown file under items/, with its highlights inside;
 * PDFs are stored once each by content hash. Positions are small per-person JSON.
 */
export const FOLDER_FILE = "reader.json";
/** The search index agents read (see sync/indexfile.ts). Written by the app, never merged. */
export const INDEX_FILE = "index.json";
export const positionsPath = (login: string) => `positions/${login}.json`;
export const pdfPath = (doc: string) => `pdfs/${doc}.pdf`;

/**
 * The largest PDF Engram stores in a repository. GitHub refuses files over 100 MB outright, and
 * a PDF goes up base64-encoded in one request (a third larger), so the cap leaves that request
 * under 100 MB too. Bigger PDFs stay on the device that has them.
 */
export const MAX_PDF_BYTES = 70 * 1024 * 1024;

/** The first layout (before items): kept so old folders and stale tabs still merge in. */
export const LEGACY_LIBRARY = "library.json";
export const legacyAnnotationsPath = (doc: string) => `annotations/${doc}.json`;

/**
 * Where a new item's file goes: items/<year>/<month>/<title-slug>-<id prefix>.md. The id prefix
 * keeps two items with the same title apart. Computed from synced fields only, so two devices
 * migrating the same folder pick the same path.
 */
export function itemPath(id: string, title: string, addedAt: number): string {
  const d = new Date(addedAt);
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `items/${d.getUTCFullYear()}/${month}/${slug ? `${slug}-` : ""}${id.replace(/-/g, "").slice(0, 8)}.md`;
}

export type PathKind =
  | { kind: "folder" }
  | { kind: "item" }
  | { kind: "index" }
  | { kind: "inbox" }
  | { kind: "positions"; user: string }
  | { kind: "pdf"; doc: string }
  | { kind: "legacyLibrary" }
  | { kind: "legacyAnnotations"; doc: string }
  | { kind: "other" };

export function parsePath(path: string): PathKind {
  if (path === FOLDER_FILE) return { kind: "folder" };
  if (path === INDEX_FILE) return { kind: "index" };
  if (/^inbox\/[^/]+\.md$/.test(path)) return { kind: "inbox" };
  if (/^items\/\d{4}\/\d{2}\/[^/]+\.md$/.test(path)) return { kind: "item" };
  let m = /^positions\/([A-Za-z0-9-]+)\.json$/.exec(path);
  if (m) return { kind: "positions", user: m[1] };
  m = /^pdfs\/([0-9a-f]{64})\.pdf$/.exec(path);
  if (m) return { kind: "pdf", doc: m[1] };
  if (path === LEGACY_LIBRARY) return { kind: "legacyLibrary" };
  m = /^annotations\/([0-9a-f]{64})\.json$/.exec(path);
  if (m) return { kind: "legacyAnnotations", doc: m[1] };
  return { kind: "other" };
}

export const isLegacy = (path: string) => parsePath(path).kind.startsWith("legacy");

/** Push order: the folder marker first, then PDFs before the items that point at them, the index last. */
export function pathPriority(path: string): number {
  const k = parsePath(path).kind;
  return k === "folder" ? -1 : k === "pdf" ? 0 : k === "item" ? 1 : k === "index" ? 4 : 3;
}
