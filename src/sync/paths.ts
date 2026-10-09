/** Repository layout. Everything is small JSON except the PDFs, which are stored once each by content hash. */
export const FOLDER_FILE = "reader.json";
export const LIBRARY = "library.json";
export const annotationsPath = (doc: string) => `annotations/${doc}.json`;
export const positionsPath = (login: string) => `positions/${login}.json`;
export const pdfPath = (doc: string) => `pdfs/${doc}.pdf`;

export type PathKind =
  | { kind: "folder" }
  | { kind: "library" }
  | { kind: "annotations"; doc: string }
  | { kind: "positions"; user: string }
  | { kind: "pdf"; doc: string }
  | { kind: "other" };

export function parsePath(path: string): PathKind {
  if (path === FOLDER_FILE) return { kind: "folder" };
  if (path === LIBRARY) return { kind: "library" };
  let m = /^annotations\/([0-9a-f]{64})\.json$/.exec(path);
  if (m) return { kind: "annotations", doc: m[1] };
  m = /^positions\/([A-Za-z0-9-]+)\.json$/.exec(path);
  if (m) return { kind: "positions", user: m[1] };
  m = /^pdfs\/([0-9a-f]{64})\.pdf$/.exec(path);
  if (m) return { kind: "pdf", doc: m[1] };
  return { kind: "other" };
}

/** Push order: the folder marker first, then PDFs before the library entries that point at them. */
export function pathPriority(path: string): number {
  const k = parsePath(path).kind;
  return k === "folder" ? -1 : k === "pdf" ? 0 : k === "library" ? 1 : k === "annotations" ? 2 : 3;
}
