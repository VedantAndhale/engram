import { folderCtx, visibleFolders } from "../folders/registry";
import type { Annotation, Item, Folder, Review } from "../model";
import { pagePartGroups } from "../notes/export";
import { updateAnnotation } from "../store/actions";
import { DAY, isRetired, nextReview, retireReview, type Schedule } from "./schedule";

/**
 * One highlighted passage. A highlight that crosses pages is stored as one annotation per page
 * (each with its page's words, or in older saves the same whole quote), so those are joined and
 * reviewed once.
 */
export interface Card {
  key: string;
  folder: Folder;
  doc: Item;
  /** Every stored annotation for this passage; the first one carries the page to open at. */
  parts: Annotation[];
  quote: string;
  note?: string;
  due: number;
  createdAt: number;
  review?: Schedule;
  /** The reader chose "Don't show again". */
  retired: boolean;
}

const reviewable = (a: Annotation) => !a.deleted && a.kind === "highlight" && !!a.quote?.trim();

export const dueAt = (a: Pick<Annotation, "review" | "createdAt">) => a.review?.due ?? a.createdAt + DAY;

/** All highlights in every folder on this device, as review cards. */
export async function allCards(): Promise<Card[]> {
  const cards: Card[] = [];
  for (const folder of await visibleFolders()) {
    const { db } = folderCtx(folder.id);
    const docs = new Map((await db.items.toArray()).filter((d) => !d.deleted).map((d) => [d.id, d]));
    const groups = new Map<string, { quote: string; parts: Annotation[] }>();
    const marks = (await db.annotations.toArray()).filter((a) => reviewable(a) && docs.has(a.doc));
    for (const { whole, parts } of pagePartGroups(marks)) {
      const quote = whole.quote!.trim();
      const key = `${folder.id}|${whole.doc}|${quote}`;
      const g = groups.get(key);
      if (g) g.parts.push(...parts);
      else groups.set(key, { quote, parts: [...parts] });
    }
    for (const [key, { quote, parts }] of groups) {
      parts.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
      const latest = parts.reduce((x, y) => ((y.review?.last ?? 0) > (x.review?.last ?? 0) ? y : x));
      cards.push({
        key,
        folder,
        doc: docs.get(parts[0].doc)!,
        parts,
        quote,
        note: parts.find((p) => p.note?.trim())?.note,
        due: dueAt(latest),
        createdAt: Math.min(...parts.map((p) => p.createdAt)),
        review: latest.review,
        retired: isRetired(latest.review),
      });
    }
  }
  return cards;
}

/** Highlights due now, oldest due first. Retired ones never are. */
export async function dueCards(now = Date.now()): Promise<Card[]> {
  return (await allCards()).filter((c) => c.due <= now && !c.retired).sort((a, b) => a.due - b.due);
}

/** How a card's parts were scheduled before a review, so the review can be taken back. */
export interface Undo {
  card: Card;
  before: (Review | undefined)[];
}

async function schedule(card: Card, next: Schedule): Promise<Undo> {
  const undo: Undo = { card, before: card.parts.map((p) => p.review) };
  // A Schedule is a Review with one optional extra; annotations are stored whole, so it syncs as it is.
  const review: Review = next;
  for (const p of card.parts) await updateAnnotation(card.folder.id, p.id, { review });
  return undo;
}

/** Record a review: "clear" spaces it further out, "hazy" brings it back tomorrow. */
export function rate(card: Card, clear: boolean, now = Date.now()): Promise<Undo> {
  return schedule(card, nextReview(card.review, clear, now, card.key));
}

/** "Don't show again": the highlight stays where it is, but never comes back for review. */
export function retire(card: Card, now = Date.now()): Promise<Undo> {
  return schedule(card, retireReview(card.review, now));
}

/** Put a card's schedule back as it was before a rating or retirement. */
export async function undoReview({ card, before }: Undo) {
  for (const [i, p] of card.parts.entries()) await updateAnnotation(card.folder.id, p.id, { review: before[i] });
}

/** Save the reader's own words on a highlight (kept on the first part, as the reader does). */
export async function saveWords(card: Card, note: string) {
  const text = note.trim() ? note : undefined;
  await updateAnnotation(card.folder.id, card.parts[0].id, { note: text });
}

export interface WeekStats {
  saved: number;
  ownWords: number;
  reviewed: number;
}

export function weekStats(cards: Card[], now = Date.now()): WeekStats {
  const since = now - 7 * DAY;
  const fresh = cards.filter((c) => c.createdAt >= since);
  return {
    saved: fresh.length,
    ownWords: fresh.filter((c) => c.note?.trim()).length,
    reviewed: cards.filter((c) => (c.review?.last ?? 0) >= since).length,
  };
}
