import { useEffect, useState } from "react";
import { folderCtx } from "../folders/registry";
import type { Folder } from "../model";
import { toast } from "../store/ui";
import { getAccount, useAccount } from "../sync/account";
import { CANT_REACH_MESSAGE } from "../sync/engine";
import { grantFolderRepo } from "../sync/install";

// Folders we already tried to fix this session. The automatic try runs once per folder, so a
// refusal doesn't loop; the button still works after that.
const tried = new Set<string>();

/**
 * When GitHub can't reach a folder's repo (in App mode), adds the repo to the App's install by
 * itself, once per session, then syncs again. `grant()` is the button for a manual retry.
 */
export function useGrantAccess(folder: Folder, message: string | undefined) {
  const app = useAccount((a) => a.account?.refresh);
  const [granting, setGranting] = useState(false);
  const needed = message === CANT_REACH_MESSAGE && !!app && !!folder.repo;

  async function run(manual: boolean) {
    const token = getAccount()?.token;
    if (!token || !folder.repo) return;
    setGranting(true);
    try {
      const result = await grantFolderRepo(token, folder.repo);
      if (result === "added") {
        folderCtx(folder.id).sync.wake();
        if (manual) toast("Engram can reach this folder's repository now. Syncing again.");
      } else if (manual) {
        toast(
          result === "not-installed"
            ? "Install Engram Reader on your GitHub account first, then try again."
            : "GitHub didn't let Engram add this repository. Select it in the Engram Reader App's settings.",
          { ttl: 12_000 },
        );
      }
    } catch (e) {
      if (manual) toast(e instanceof Error ? e.message : String(e), { ttl: 12_000 });
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

  return { needed, granting, grant: () => run(true) };
}
