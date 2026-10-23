// The inbox rule for links: a link stays in Inbox for a week after it came in. After that it leaves Inbox, and the
// library shows it under Unread if it is still unread, or in Archive if it has been read. The item itself is not
// changed, so the rule writes nothing and syncs nothing. Pure, so the tests can run it in Node.
import type { ItemType, Location } from "../model";

/** How long a link stays in Inbox before it leaves it. */
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
 * Whether a link has been in Inbox for INBOX_DAYS, and was added after `since` (the day the rule started on this
 * device). Such a link is no longer shown in Inbox. Older links keep where they are.
 */
export function isAgedOutOfInbox(item: AgingItem, now: number, since: number): boolean {
  return !item.deleted && item.location === "inbox" && LINK_TYPES.includes(item.type) && item.addedAt >= since && now - item.enteredInbox >= INBOX_DAYS * DAY;
}
