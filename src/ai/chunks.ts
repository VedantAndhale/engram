/*
 * Fitting a saved text into the model's context window. The window is small (see GEMMA in model.ts),
 * so a long item is cut into passages, and a question is answered from the passages that share
 * its words. No model is needed for this, so it works the same on every device.
 */

/** Common words that say nothing about what a passage is about. */
const STOP = new Set([
  "the", "and", "for", "that", "with", "this", "from", "what", "when", "where", "which", "have", "has", "are", "was",
  "were", "your", "about", "into", "does", "how", "why", "who", "its", "not", "can", "but", "they", "them", "there",
  "their", "will", "would", "should", "could", "than", "then", "also", "just", "some", "more", "most", "such",
]);

/**
 * The words of a text that can tell passages apart: lowercase, at least three letters, no common
 * words. A plural "s" is dropped, so "rivers" and "river" count as the same word.
 */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Split text into passages of about `size` characters, keeping paragraphs whole where they fit. */
export function chunkText(text: string, size = 1200): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    for (const piece of splitLong(paragraph, size)) {
      if (current && current.length + piece.length + 2 > size) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

/** What was picked for a question, and how much of the text that is. */
export interface Picked {
  /** The passages sent to the model, in their original order. */
  texts: string[];
  /** The position of each passage sent, in the item's passage order. */
  indexes: number[];
  /** How many passages were sent, out of `passages`. */
  sent: number;
  passages: number;
  /** Characters sent, and the length of the whole text they came from. */
  usedChars: number;
  totalChars: number;
  /** True when no passage shared a word with the question, so the opening passages were sent instead. */
  fallback: boolean;
}

/**
 * The passages most likely to answer `question`, in their original order, within `budget`
 * characters. Passages sharing more words with the question come first. With no shared words,
 * the opening passages are used, and `fallback` says so.
 */
export function pickPassages(
  question: string,
  chunks: string[],
  budget = 6000,
  totalChars = chunks.reduce((n, c) => n + c.length, 0),
  skip: Set<number> = new Set(),
): Picked {
  const wanted = new Set(terms(question));
  // Passages already sent earlier in a thread are left out, so a follow-up brings new ones.
  const candidates = chunks
    .map((text, index) => ({ index, text, score: terms(text).reduce((n, w) => n + (wanted.has(w) ? 1 : 0), 0) }))
    .filter((c) => !skip.has(c.index));
  const matched = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const order = matched.length > 0 ? matched : candidates;

  const chosen: { index: number; text: string }[] = [];
  let used = 0;
  for (const c of order) {
    if (used + c.text.length > budget) continue;
    chosen.push(c);
    used += c.text.length;
  }
  chosen.sort((a, b) => a.index - b.index);
  return {
    texts: chosen.map((c) => c.text),
    indexes: chosen.map((c) => c.index),
    sent: chosen.length,
    passages: chunks.length,
    usedChars: used,
    totalChars,
    fallback: candidates.length > 0 && matched.length === 0,
  };
}

/** The passages most likely to answer `question`, in their original order, within `budget` characters. */
export function pickChunks(question: string, chunks: string[], budget = 6000): string[] {
  return pickPassages(question, chunks, budget).texts;
}

/**
 * The passages of an article, each paragraph labelled [¶n] with its number, so an answer can cite
 * the paragraph. A paragraph longer than a passage is cut into pieces that keep its number.
 */
export function articlePassages(paragraphs: { n: number; text: string }[], size = 1200): string[] {
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (!p.text) continue;
    const label = `[¶${p.n}]\n`;
    const room = Math.max(200, size - label.length);
    for (let i = 0; i < p.text.length; i += room) pieces.push(label + p.text.slice(i, i + room));
  }
  const passages: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      passages.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) passages.push(current);
  return passages;
}
