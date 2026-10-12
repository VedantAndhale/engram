import { useLiveQuery } from "dexie-react-hooks";
import { BookmarkPlus, Check, ClipboardPaste, LoaderCircle, Share, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { asCapture, bookmarkletHref, READY, type CaptureMessage } from "../capture/bookmarklet";
import {
  asUrl,
  fetchedLater,
  hostOf,
  itemHref,
  saveLink,
  saveNote,
  saveQuote,
  titleFromUrl,
  typeForUrl,
  TYPE_LABELS,
  type CaptureKind,
} from "../capture/capture";
import { visibleFolders } from "../folders/registry";
import { installApp, isIOS, useInstall } from "../lib/install";
import { setHabit, useHabit } from "../habit/prefs";
import type { Folder, ItemType } from "../model";
import { closeQuickAdd, lastFolder, toast, useUI, type QuickAddPrefill } from "../store/ui";
import { Modal } from "./common";
import { TopicPicker } from "./habit";

/** Topics first typed while saving become the reader's topics too. */
function rememberTopics(chosen: string[]) {
  const mine = useHabit.getState().topics;
  const added = chosen.filter((t) => !mine.includes(t));
  if (added.length) setHabit({ topics: [...mine, ...added] });
}

function FolderSelect({ folders, value, onChange }: { folders: Folder[]; value: string; onChange: (id: string) => void }) {
  if (folders.length < 2) return null;
  return (
    <label>
      <span>Folder</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Ctrl/Cmd+Enter saves from anywhere in a capture form. */
const saveKey = (save: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    save();
  }
};

// ---------------------------------------------------------------------------------------------

/** The save box: a link, a quote or a note, in a second. Opened from anywhere. */
export function QuickAdd() {
  const prefill = useUI((s) => s.quickAdd);
  return prefill ? <QuickAddDialog prefill={prefill} /> : null;
}

function QuickAddDialog({ prefill }: { prefill: QuickAddPrefill }) {
  const folders = useLiveQuery(visibleFolders, []);
  const allTopics = useHabit((h) => h.topics);
  const [text, setText] = useState(prefill.text ?? "");
  const [chosenKind, setKind] = useState<CaptureKind | null>(null);
  const [title, setTitle] = useState(prefill.title ?? "");
  const [source, setSource] = useState("");
  const [words, setWords] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [folderId, setFolderId] = useState(prefill.folder ?? lastFolder() ?? "");
  const [busy, setBusy] = useState(false);

  const url = asUrl(text);
  const kind: CaptureKind = chosenKind ?? (url ? "link" : "note");
  const folder = folders?.find((f) => f.id === folderId) ?? folders?.[0];
  const canSave = !!folder && !busy && (kind === "link" ? !!url : !!text.trim());

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      let item;
      let existed = false;
      if (kind === "link") ({ item, existed } = await saveLink(folder.id, { url: url!, title: title.trim() || undefined, words, topics }));
      else if (kind === "quote") item = await saveQuote(folder.id, { quote: text, source, words, topics });
      else item = await saveNote(folder.id, { text, topics });
      rememberTopics(topics);
      closeQuickAdd();
      toast(existed ? "You'd saved that already. Added to it." : `Saved to ${folder.name}.`, {
        action: { label: "Open", run: () => (location.hash = itemHref(folder.id, item)) },
      });
    } catch (e) {
      console.error(e);
      toast("Couldn't save that. Try again.");
      setBusy(false);
    }
  };

  const canPaste = typeof navigator.clipboard?.readText === "function";
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) setText(t.trim());
    } catch {
      toast("Couldn't read the clipboard. Paste into the box instead.");
    }
  };

  return (
    <Modal title="Save" onClose={closeQuickAdd}>
      <div className="form capture-form" onKeyDown={saveKey(save)}>
        <div className="segmented" role="tablist" aria-label="What are you saving?">
          {(["link", "quote", "note"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {k === "link" ? "Link" : k === "quote" ? "Quote" : "Note"}
            </button>
          ))}
        </div>

        <label>
          <span className="label-row">
            {kind === "link" ? "Link" : kind === "quote" ? "The quote" : "Your note"}
            {canPaste && (
              <button type="button" className="link" onClick={paste}>
                <ClipboardPaste size={14} /> Paste
              </button>
            )}
          </span>
          <textarea
            autoFocus
            rows={kind === "link" ? 2 : 5}
            value={text}
            placeholder={kind === "link" ? "https://…" : kind === "quote" ? "Words worth keeping, exactly as written" : "What's on your mind?"}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {kind === "link" && text.trim() && !url && <p className="hint">Paste a whole link, starting with https://</p>}

        {kind === "link" && url && (
          <label>
            <span>Title</span>
            <input value={title} placeholder={titleFromUrl(url)} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}

        {kind === "quote" && (
          <label>
            <span>Source</span>
            <input value={source} placeholder="A book, a speaker or a page (optional)" onChange={(e) => setSource(e.target.value)} />
          </label>
        )}

        {kind !== "note" && (
          <label>
            <span>In your own words</span>
            <input value={words} placeholder="Why does this matter to you? (optional)" onChange={(e) => setWords(e.target.value)} />
          </label>
        )}

        <div className="field">
          <span className="field-label">Topics</span>
          <TopicPicker options={allTopics} value={topics} onChange={setTopics} />
        </div>

        {folders && folder && <FolderSelect folders={folders} value={folder.id} onChange={setFolderId} />}

        {kind === "link" && url && (
          <p className="hint">
            {fetchedLater(url) && "The page's text and details, like its author and date, are fetched in the background. "}To keep a passage you've
            selected, use Save to Engram on the page.
          </p>
        )}

        <footer>
          <button type="button" className="btn" onClick={closeQuickAdd}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>
            {busy && <LoaderCircle size={14} className="spin" />} Save
          </button>
        </footer>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * The window the bookmarklet opens. It tells the page it's ready, receives the page, and asks
 * before saving: any site could open this window, so nothing is saved without your click.
 */
export function SavePage() {
  const folders = useLiveQuery(visibleFolders, []);
  const allTopics = useHabit((h) => h.topics);
  const [page, setPage] = useState<{ data: CaptureMessage; from: string } | null>(null);
  const [type, setType] = useState<ItemType>("bookmark");
  const [title, setTitle] = useState("");
  const [words, setWords] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [folderId, setFolderId] = useState(lastFolder() ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    document.title = "Save to Engram";
    const opener = window.opener as Window | null;
    if (!opener) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== opener) return;
      const data = asCapture(e.data);
      if (!data) return;
      setPage({ data, from: e.origin });
      setType(typeForUrl(data.url, data.text.length));
      setTitle(data.title.trim());
    };
    window.addEventListener("message", onMessage);
    opener.postMessage(READY, "*"); // carries nothing; the page answers only to Engram's origin
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const folder = folders?.find((f) => f.id === folderId) ?? folders?.[0];

  const save = async () => {
    if (!page || !folder || state !== "idle") return;
    setState("saving");
    try {
      const { existed } = await saveLink(folder.id, {
        url: page.data.url,
        title,
        text: page.data.text,
        html: page.data.html || undefined,
        selection: page.data.selection,
        author: page.data.author,
        siteName: page.data.siteName,
        description: page.data.description,
        published: page.data.published,
        type,
        words,
        topics,
      });
      rememberTopics(topics);
      setState("saved");
      document.title = existed ? "Updated in Engram" : "Saved to Engram";
      // Give the upload a moment to queue, then get out of the way.
      setTimeout(() => window.close(), 1200);
    } catch (e) {
      console.error(e);
      setState("idle");
      toast("Couldn't save that. Try again.");
    }
  };

  if (!window.opener) {
    return (
      <main className="save-page">
        <h1>
          <BookmarkPlus size={20} /> Save to Engram
        </h1>
        <p className="muted">This window opens when you use the Save to Engram bookmark on a page.</p>
        <BookmarkletCard />
      </main>
    );
  }

  if (!page) {
    return (
      <main className="save-page">
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Waiting for the page…
        </p>
        <p className="hint">If nothing happens, close this window and try the bookmark again after the page finishes loading.</p>
      </main>
    );
  }

  if (state === "saved") {
    return (
      <main className="save-page saved">
        <Check size={28} />
        <h1>Saved</h1>
      </main>
    );
  }

  const selection = page.data.selection.trim();
  return (
    <main className="save-page">
      <h1>
        <BookmarkPlus size={20} /> Save to Engram
      </h1>
      <div className="form capture-form" onKeyDown={saveKey(save)}>
        <p className="hint">From {hostOf(page.data.url) || page.from}</p>
        <label>
          <span>Title</span>
          <input value={title} placeholder={titleFromUrl(page.data.url)} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span>Type</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as ItemType)}>
            {(Object.keys(TYPE_LABELS) as ItemType[])
              .filter((t) => t !== "pdf" && t !== "note")
              .map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
          </select>
        </label>
        {selection && (
          <blockquote className="capture-quote" title="Saved as a highlight">
            {selection.length > 400 ? `${selection.slice(0, 400)}…` : selection}
          </blockquote>
        )}
        <label>
          <span>In your own words</span>
          <textarea autoFocus rows={2} value={words} placeholder="Why does this matter to you? (optional)" onChange={(e) => setWords(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Topics</span>
          <TopicPicker options={allTopics} value={topics} onChange={setTopics} />
        </div>
        {folders && folder && <FolderSelect folders={folders} value={folder.id} onChange={setFolderId} />}
        <p className="hint">
          {page.data.text.trim()
            ? `Keeps the page's text (${Math.round(page.data.text.length / 1000) || 1}k characters)`
            : fetchedLater(page.data.url)
              ? "Keeps the link. Its text and details are fetched in the background"
              : "Keeps the link"}
          {selection ? ", with your selection as a highlight." : "."}
        </p>
        <footer>
          <button type="button" className="btn" onClick={() => window.close()}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!folder || state !== "idle"} onClick={save}>
            {state === "saving" && <LoaderCircle size={14} className="spin" />} Save
          </button>
        </footer>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------

/** How to save from other places: the bookmark on desktop, the share sheet or paste on phones. */
export function BookmarkletCard() {
  const link = useRef<HTMLAnchorElement>(null);
  // React refuses to render javascript: links, so the address is set directly.
  useEffect(() => link.current?.setAttribute("href", bookmarkletHref()), []);
  return (
    <div className="bookmarklet">
      <p className="muted">Drag this to your bookmarks bar. On any page, click it to save the page, its text and what you've selected.</p>
      <a
        ref={link}
        className="btn bookmarklet-btn"
        onClick={(e) => {
          e.preventDefault();
          toast("Drag it to your bookmarks bar, then click it on any page.");
        }}
      >
        <BookmarkPlus size={16} /> Save to Engram
      </a>
      <p className="hint">
        On Android, install Engram and share to it from any app. On iPhone, copy a link, then open Engram and paste it into Save.
      </p>
      <InstallButton />
    </div>
  );
}

/**
 * Install Engram on a phone. Android (and desktop Chrome) installs straight from the browser's
 * own dialog; Safari on iPhone and iPad can only install from its Share menu, so that is shown.
 */
function InstallButton() {
  const { prompt, installed } = useInstall();
  const [help, setHelp] = useState(false);
  const ios = isIOS();
  if (installed || (!prompt && !ios)) return null;
  return (
    <>
      <button
        className="btn"
        onClick={async () => {
          if (!prompt) return setHelp(true);
          if (await installApp()) toast("Engram is installed. Open it from your home screen.");
        }}
      >
        <Smartphone size={16} /> Install app
      </button>
      {help && (
        <Modal title="Install Engram" onClose={() => setHelp(false)}>
          <div className="form">
            <ol className="steps">
              <li>
                In Safari, tap <Share size={14} aria-label="Share" /> <strong>Share</strong>.
              </li>
              <li>
                Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
              </li>
              <li>Open Engram from your home screen. It works offline, like any other app.</li>
            </ol>
            <p className="hint">In another browser on iPhone, open this page in Safari first.</p>
            <footer>
              <button className="btn btn-primary" onClick={() => setHelp(false)}>
                Got it
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
