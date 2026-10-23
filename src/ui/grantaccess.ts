import { useEffect, useState } from "react";
import { folderCtx } from "../folders/registry";
import type { Folder } from "../model";
import { toast } from "../store/ui";
import { getAccount, useAccount } from "../sync/account";
import { CANT_REACH_MESSAGE } from "../sync/engine";
import { grantFolderRepo, type ReachOutcome } from "../sync/install";

// Folders we already tried to fix this session. The automatic try runs once per folder, so a
// refusal doesn't loop; the button still works after that.
const tried = new Set<string>();

/** What to tell the user when the repo still can't be added. */
export function problemText(o: ReachOutcome): string | null {
  if (o.result === "added") return null;
  if (o.result === "not-installed") return "Engram Reader isn't installed on this GitHub account yet.";
  if (o.status === 404) return "Engram can't add this repository by itself. Select it in the Engram Reader App's settings on GitHub.";
  const said = o.message ? ` ("${o.message}")` : "";
  return `GitHub answered ${o.status ?? "with an error"}${said} when Engram tried to add this repository. Select it in the Engram Reader App's settings on GitHub.`;
}

/**
 * When GitHub can't reach a folder's repo (in App mode), adds the repo to the App's install by
 * itself, once per session, then syncs again. `grant()` is the button for a manual retry.
 * `problem` stays set while the repo still can't be added, so the reason is visible.
 */
export function useGrantAccess(folder: Folder, message: string | undefined) {
  const app = useAccount((a) => a.account?.refresh);
  const [granting, setGranting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const needed = message === CANT_REACH_MESSAGE && !!app && !!folder.repo;

  async function run(manual: boolean) {
    const token = getAccount()?.token;
    if (!token || !folder.repo) return;
    setGranting(true);
    try {
      const outcome = await grantFolderRepo(token, folder.repo);
      const text = problemText(outcome);
      setProblem(text);
      if (outcome.result === "added") {
        folderCtx(folder.id).sync.wake();
        if (manual) toast("Engram can reach this folder's repository now. Syncing again.");
      } else if (manual && text) {
        toast(text, { ttl: 12_000 });
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setProblem(text);
      if (manual) toast(text, { ttl: 12_000 });
    } finally {
      setGranting(false);
    }
  }

  useEffect(() => {
    if (!needed || tried.has(folder.id)) return;
    tried.add(folder.id);
    void run(false);
    // run reads the current folder and token; only a change of folder or error needs a new try.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed, folder.id]);

  return { needed, granting, problem, grant: () => run(true) };
}
