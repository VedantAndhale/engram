import { folderCtx, visibleFolders } from "../folders/registry";
import type { Annotation, DocMeta, Folder, Review } from "../model";
import { updateAnnotation } from "../store/actions";

const DAY = 86_400_000;
/** Days until a highlight comes back, by step. Still clear moves one step on; hazy goes back to the start. */
const INTERVALS = [1, 3, 7, 16, 35, 90];

/**
 * One highlighted passage. A highlight that crosses pages is stored as one annotation per page
 * with the same quote, so those are grouped and reviewed once.
 */
export interface Card {
  key: string;
  folder: Folder;
  doc: DocMeta;
  /** Every stored annotation for this passage; the first one carries the page to open at. */
  parts: Annotation[];
  quote: string;
  note?: string;
  due: number;
  createdAt: number;
  review?: Review;
}

const reviewable = (a: Annotation) => !a.deleted && a.kind === "highlight" && !!a.quote?.trim();

export const dueAt = (a: Pick<Annotation, "review" | "createdAt">) => a.review?.due ?? a.createdAt + DAY;

/** All highlights in every folder on this device, as review cards. */
export async function allCards(): Promise<Card[]> {
  const cards: Card[] = [];
  for (const folder of await visibleFolders()) {
    const { db } = folderCtx(folder.id);
    const docs = new Map((await db.docs.toArray()).filter((d) => !d.deleted).map((d) => [d.hash, d]));
    const groups = new Map<string, Annotation[]>();
    for (const a of await db.annotations.toArray()) {
      if (!reviewable(a) || !docs.has(a.doc)) continue;
      const key = `${folder.id}|${a.doc}|${a.quote!.trim()}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    for (const [key, parts] of groups) {
      parts.sort((a, b) => a.page - b.page);
      const latest = parts.reduce((x, y) => ((y.review?.last ?? 0) > (x.review?.last ?? 0) ? y : x));
      cards.push({
        key,
        folder,
        doc: docs.get(parts[0].doc)!,
        parts,
        quote: parts[0].quote!.trim(),
        note: parts.find((p) => p.note?.trim())?.note,
        due: dueAt(latest),
        createdAt: Math.min(...parts.map((p) => p.createdAt)),
        review: latest.review,
      });
    }
  }
  return cards;
}

/** Highlights due now, oldest due first. */
export async function dueCards(now = Date.now()): Promise<Card[]> {
  return (await allCards()).filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
}

/** Record a review: "clear" spaces it further out, "hazy" brings it back tomorrow. */
export async function rate(card: Card, clear: boolean, now = Date.now()) {
  const step = clear ? Math.min((card.review?.step ?? 0) + 1, INTERVALS.length - 1) : 0;
  const review: Review = { step, due: now + INTERVALS[step] * DAY, last: now, count: (card.review?.count ?? 0) + 1 };
  for (const p of card.parts) await updateAnnotation(card.folder.id, p.id, { review });
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
