// The inbox rule for links: a link waits in Inbox for a week, then moves to Later. Pure, so the tests can run it in Node.
import type { ItemType, Location } from "../model";

/** How long a link waits in Inbox before it moves to Later. */
export const INBOX_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** The kinds of item the rule applies to: links and what they point to. Notes, quotes, PDFs, books and videos stay where they are. */
export const LINK_TYPES: ItemType[] = ["article", "post", "tweet", "thread", "bookmark"];

export interface AgingItem {
  id: string;
  type: ItemType;
  location?: Location;
  /** When the item was added. Only items added after the rule began count. */
  addedAt: number;
  /** When it last came into Inbox by hand, or when it was added. The week is counted from here. */
  enteredInbox: number;
  deleted?: boolean;
}

/**
 * The ids to move from Inbox to Later at `now`: link items in Inbox for INBOX_DAYS since they came in, that were
 * added after `since` (the day the rule started on this device). Older links keep where they are.
 */
export function agedFromInbox(items: AgingItem[], now: number, since: number): string[] {
  return items
    .filter((i) => !i.deleted && i.location === "inbox" && LINK_TYPES.includes(i.type) && i.addedAt >= since && now - i.enteredInbox >= INBOX_DAYS * DAY)
    .map((i) => i.id);
}
