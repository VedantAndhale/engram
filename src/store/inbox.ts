import { saveLink, saveNote, saveQuote } from "../capture/capture";
import type { InboxRow } from "../db/db";
import { folderCtx } from "../folders/registry";
import { updateItem } from "./actions";
import { externalUrl } from "../lib/util";

/*
 * Deciding on what agents sent. Accepting does what you'd have done yourself (saves the link,
 * adds the lines), signed with the agent's name; either way the inbox file is deleted on sync.
 */

const day = (t: number) => new Date(t || Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "short" });

async function resolve(folder: string, path: string, resolved: InboxRow["resolved"]) {
  const { db, sync } = folderCtx(folder);
  await db.inbox.update(path, { resolved });
  await sync.markDirty(path, 0);
}

/** Returns what was made or changed, so the caller can open it. */
export async function acceptInbox(folder: string, row: InboxRow): Promise<{ item: string }> {
  const e = row.entry;
  const sign = `*From ${e.agent}, ${day(e.createdAt)}${e.why ? `: ${e.why}` : ""}*`;
  let item: string;
  if (e.kind === "note") {
    const { db } = folderCtx(folder);
    const target = e.target ? await db.items.get(e.target) : undefined;
    if (!target || target.deleted) throw new Error(`"${e.targetTitle ?? "That item"}" isn't in this folder any more.`);
    const add = `${e.text?.trim() ?? ""}\n\n${sign}`;
    await updateItem(folder, target.id, { body: target.body?.trim() ? `${target.body.trim()}\n\n${add}` : add }, 500);
    item = target.id;
  } else {
    const words = [e.text?.trim(), sign].filter(Boolean).join("\n\n");
    // Entries sent before the agent tool stopped using the address as a title still carry it; that's no title.
    const title = e.title === e.sourceUrl ? undefined : e.title;
    if (externalUrl(e.sourceUrl)) item = (await saveLink(folder, { url: e.sourceUrl!, title, text: e.content, words })).item.id;
    else if (e.content?.trim()) item = (await saveQuote(folder, { quote: e.content, words })).id;
    else item = (await saveNote(folder, { text: words })).id;
  }
  await resolve(folder, row.path, "accepted");
  return { item };
}

export const dismissInbox = (folder: string, row: InboxRow) => resolve(folder, row.path, "dismissed");
