import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState, type ChangeEvent } from "react";
import { Modal } from "../ui/common";
import { visibleFolders } from "../folders/registry";
import { importBooks, type ImportResult } from "./books";
import { detectFormat } from "./detect";
import { parseKindle } from "./kindle";
import { parseLinks, type LinkRow } from "./links";
import { parseReadwiseCsv } from "./readwise";
import { importLinks, type LinkImportResult } from "./saveLinks";
import type { ImportBook } from "./types";

// Files are read whole into memory, so a cap keeps a wrong pick from freezing the tab.
const MAX_BYTES = 20 * 1024 * 1024;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ImportDialog({ onClose, folder }: { onClose: () => void; folder?: string }) {
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const [folderId, setFolderId] = useState("");
  // The folder the reader is viewing is the default; the first folder is the fallback, unless the reader picks another.
  const chosenFolder = folderId || folder || folders[0]?.id || "";
  const [books, setBooks] = useState<ImportBook[] | null>(null);
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);
  const [linkResult, setLinkResult] = useState<LinkImportResult | null>(null);
  // Counts the picks. A read that finishes after a newer pick has started must not overwrite what that pick shows.
  const latestPick = useRef(0);

  async function pickFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    // Cleared, so picking the same file again after an edit reads it again.
    e.target.value = "";
    const pick = ++latestPick.current;
    setBooks(null);
    setLinks(null);
    setWarnings([]);
    setError("");
    setResult(null);
    setLinkResult(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is over 20 MB, which is too big to import.");
      return;
    }
    try {
      const text = await file.text();
      if (pick !== latestPick.current) return;
      const format = detectFormat(text);
      if (format === "unknown") {
        setError("We don't know this file. Use a Kindle My Clippings.txt, a Readwise CSV export, or a CSV with a link column.");
        return;
      }
      if (format === "links") {
        const found = parseLinks(text);
        // The warnings are kept even when nothing is found: they say why the rows were left out.
        setWarnings(found.warnings);
        if (found.links.length === 0) {
          setError("No links were found in that file.");
          return;
        }
        setLinks(found.links);
        return;
      }
      const parsed = format === "kindle" ? parseKindle(text) : parseReadwiseCsv(text);
      setWarnings(parsed.warnings);
      if (parsed.books.length === 0) {
        setError("No highlights were found in that file.");
        return;
      }
      setBooks(parsed.books);
    } catch (err) {
      if (pick === latestPick.current) setError(err instanceof Error ? err.message : "We couldn't read that file.");
    }
  }

  async function run(): Promise<void> {
    if ((!books && !links) || !chosenFolder) return;
    setRunning(true);
    setError("");
    try {
      if (links) {
        setProgress({ done: 0, total: links.length });
        setLinkResult(await importLinks(chosenFolder, links, (done, total) => setProgress({ done, total })));
      } else if (books) {
        setProgress({ done: 0, total: books.length });
        setResult(await importBooks(chosenFolder, books, (done, total) => setProgress({ done, total })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The import stopped unexpectedly.");
    } finally {
      setRunning(false);
    }
  }

  const highlightCount = books?.reduce((n, b) => n + b.highlights.length, 0) ?? 0;
  const noteCount = books?.reduce((n, b) => n + b.notes.length, 0) ?? 0;

  return (
    <Modal title="Import" onClose={onClose}>
      <div className="form">
        <label>
          <span>Kindle My Clippings.txt, Readwise CSV, or a CSV of links</span>
          <input type="file" accept=".txt,.csv" disabled={running} onChange={(e) => void pickFile(e)} />
        </label>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {warnings.length > 0 && (
          <ul className="hint import-warnings" aria-label="Warnings">
            {warnings.slice(0, 5).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {warnings.length > 5 && <li>and {warnings.length - 5} more.</li>}
          </ul>
        )}

        {(books || links) && (
          <>
            {books && (
              <p>
                Found {plural(books.length, "book")}, {plural(highlightCount, "highlight")} and {plural(noteCount, "note")}.
              </p>
            )}
            {links && <p>Found {plural(links.length, "link")}. Each one is saved as a link item; its page is not downloaded.</p>}
            <label>
              <span>Import into</span>
              <select value={chosenFolder} disabled={running} onChange={(e) => setFolderId(e.target.value)}>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">Nothing is written until you press Import.</p>
          </>
        )}

        <div role="status">
          {running && (
            <p>
              Importing… {progress.done}/{progress.total}
              <span className="hint"> You can close this. The import keeps going.</span>
            </p>
          )}
          {result && (
            <p>
              Imported {plural(result.books - result.failed, "book")} and {plural(result.highlights, "highlight")}. {result.alreadyThere} already there.
              {result.failed > 0 && ` ${plural(result.failed, "book")} could not be imported.`}
            </p>
          )}
          {linkResult && (
            <p>
              Saved {plural(linkResult.created, "link")}. {linkResult.alreadyThere} already there.
              {linkResult.failed > 0 && ` ${plural(linkResult.failed, "link")} could not be saved.`}
            </p>
          )}
        </div>

        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={(!books && !links) || !chosenFolder || running || result !== null || linkResult !== null} onClick={() => void run()}>
            Import
          </button>
        </footer>
      </div>
    </Modal>
  );
}