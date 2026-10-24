import { useEffect, useRef, useState } from "react";
import { followFeeds, forgetFeedDecisions, recordFeedDecisions, scanForFeeds, type FeedFound } from "../feeds/follow";
import { useHabit } from "../habit/prefs";

// Each listed site and feed is its own row, so the same feed listed for two sites can be picked for each.
const keyOf = (f: FeedFound) => `${f.site} ${f.feed}`;

/**
 * Looks at one article from each site saved in a folder kept on GitHub, and lists the feeds those sites publish.
 * Nothing is checked by default: the reader picks which to follow.
 */
export function FindFeeds({ onFollowed }: { onFollowed: () => void }) {
  const [phase, setPhase] = useState<"idle" | "scanning" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [found, setFound] = useState<FeedFound[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const stop = useRef<{ current: boolean }>({ current: false });
  const feedAsked = useHabit((s) => s.feedAsked);
  // Sites decided about, so the reader can check one again. Sorted so the list stays put.
  const asked = [...(feedAsked ?? [])].sort();

  // Leaving the page stops a scan that is still running.
  useEffect(() => () => void (stop.current.current = true), []);

  const scan = async () => {
    stop.current.current = false;
    setPhase("scanning");
    setMessage(null);
    setProgress({ done: 0, total: 0 });
    try {
      const result = await scanForFeeds((done, total) => setProgress({ done, total }), stop.current);
      setFound(result.found);
      setPicked(new Set());
      setPhase("done");
      const notes: string[] = [];
      if (result.total === 0) notes.push("Nothing new to check: every site has been looked at.");
      if (result.capped) notes.push(`Checked ${result.total} sites. Scan again for the rest.`);
      if (result.alreadyFollowed) notes.push(`${result.alreadyFollowed} already followed, not listed.`);
      if (notes.length) setMessage(notes.join(" "));
    } catch (e) {
      setPhase("idle");
      setMessage(`The scan stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const follow = async () => {
    const chosen = found.filter((f) => picked.has(keyOf(f)));
    const r = await followFeeds(chosen.map((f) => f.feed));
    // Nothing was saved, so nothing is decided and the list stays for another try.
    if (r.error) {
      setMessage(r.error);
      return;
    }
    // A listed site is decided once the reader has acted on it. The exception is a picked feed that was refused:
    // that site is listed again on the next scan.
    const done = new Set(r.done);
    recordFeedDecisions(found.filter((f) => !picked.has(keyOf(f)) || done.has(f.feed)).map((f) => f.site));
    const parts = [r.added ? `Following ${r.added} feed${r.added === 1 ? "" : "s"}.` : "Already following those feeds."];
    if (r.reason) parts.push(`Not followed: ${r.reason}`);
    setMessage(parts.join(" "));
    setFound([]);
    setPicked(new Set());
    setPhase("idle");
    if (r.added) onFollowed();
  };

  const notNow = () => {
    recordFeedDecisions(found.map((f) => f.site));
    setFound([]);
    setPicked(new Set());
    setPhase("idle");
    setMessage("Those sites won't be listed again.");
  };

  // Clears the decision for a site, so the next scan or saved article from it is looked at again.
  const checkAgain = (site: string) => {
    forgetFeedDecisions([site]);
    setMessage(`${site} will be checked again the next time you scan or save from it.`);
  };

  const toggle = (key: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div>
      <p className="muted">
        Looks at one article from each site you saved in folders kept on GitHub, and lists the feeds those sites publish.
        Each article's address is sent to Engram's page reader to read the page. Nothing is followed until you choose it.
      </p>
      {phase === "scanning" ? (
        <p className="muted">
          Checked {progress.done} of {progress.total} sites…
        </p>
      ) : (
        <button className="btn btn-small" onClick={() => void scan()}>
          Find feeds in my articles
        </button>
      )}
      {phase === "done" && found.length === 0 && <p className="muted">No feeds found on those sites.</p>}
      {found.length > 0 && (
        <>
          <ul>
            {found.map((f) => (
              <li key={keyOf(f)}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(keyOf(f))}
                    onChange={(e) => toggle(keyOf(f), e.target.checked)}
                  />{" "}
                  <strong>{f.site}</strong> <span className="muted">{f.feed}</span>
                </label>
              </li>
            ))}
          </ul>
          <button className="btn btn-small btn-primary" disabled={!picked.size} onClick={() => void follow()}>
            Follow {picked.size} selected
          </button>{" "}
          <button className="btn btn-small" onClick={notNow}>
            Not now
          </button>
        </>
      )}
      {message && <p className="muted">{message}</p>}
      {asked.length > 0 && (
        <details>
          <summary>Sites already checked ({asked.length})</summary>
          <ul>
            {asked.map((site) => (
              <li key={site}>
                {site}{" "}
                <button className="btn btn-small" onClick={() => checkAgain(site)} aria-label={`Check ${site} again`}>
                  Check again
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
