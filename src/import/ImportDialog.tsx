import { useLiveQuery } from "dexie-react-hooks";
import { useState, type ChangeEvent } from "react";
import { Modal } from "../ui/common";
import { visibleFolders } from "../folders/registry";
import { importBooks, type ImportResult } from "./books";
import { detectFormat } from "./detect";
import { parseKindle } from "./kindle";
import { parseReadwiseCsv } from "./readwise";
import type { ImportBook } from "./types";

// Files are read whole into memory, so a cap keeps a wrong pick from freezing the tab.
const MAX_BYTES = 20 * 1024 * 1024;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const folders = useLiveQuery(visibleFolders, []) ?? [];
  const [folderId, setFolderId] = useState("");
  // The first folder is the default once the list has loaded, unless the reader already picked one.
  const chosenFolder = folderId || folders[0]?.id || "";
  const [books, setBooks] = useState<ImportBook[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);

  async function pickFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    setBooks(null);
    setWarnings([]);
    setError("");
    setResult(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is over 20 MB, which is too big to import.");
      return;
    }
    try {
      const text = await file.text();
      const format = detectFormat(text);
      if (format === "unknown") {
        setError("We don't know this file. Use a Kindle My Clippings.txt or a Readwise CSV export.");
        return;
      }
      const parsed = format === "kindle" ? parseKindle(text) : parseReadwiseCsv(text);
      if (parsed.books.length === 0) {
        setError("No highlights were found in that file.");
        return;
      }
      setBooks(parsed.books);
      setWarnings(parsed.warnings.slice(0, 5));
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't read that file.");
    }
  }

  async function run(): Promise<void> {
    if (!books || !chosenFolder) return;
    setRunning(true);
    setError("");
    setProgress({ done: 0, total: books.length });
    try {
      setResult(await importBooks(chosenFolder, books, (done, total) => setProgress({ done, total })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The import stopped unexpectedly.");
    } finally {
      setRunning(false);
    }
  }

  const highlightCount = books?.reduce((n, b) => n + b.highlights.length, 0) ?? 0;
  const noteCount = books?.reduce((n, b) => n + b.notes.length, 0) ?? 0;

  return (
    <Modal title="Import highlights" onClose={onClose}>
      <div className="form">
        <label>
          <span>Kindle My Clippings.txt or Readwise CSV</span>
          <input type="file" accept=".txt,.csv" disabled={running} onChange={(e) => void pickFile(e)} />
        </label>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {books && (
          <>
            <p>
              Found {plural(books.length, "book")}, {plural(highlightCount, "highlight")} and {plural(noteCount, "note")}.
            </p>
            {warnings.length > 0 && (
              <ul className="hint import-warnings" aria-label="Warnings">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
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
              Imported {plural(result.books - result.failed, "book")} and {plural(result.highlights, "highlight")}. {result.alreadyThere} were already there.
              {result.failed > 0 && ` ${plural(result.failed, "book")} could not be imported.`}
            </p>
          )}
        </div>

        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={!books || !chosenFolder || running || result !== null} onClick={() => void run()}>
            Import
          </button>
        </footer>
      </div>
    </Modal>
  );
}