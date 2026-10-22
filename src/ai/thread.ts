/*
 * The follow-up threads of one item's Ask dialog. A thread keeps its turns (the question, the answer,
 * and the passages it used) in memory, so closing the dialog does not lose them. The model keeps the
 * conversation itself, in the worker; this store knows how much room is left in it, and whether that
 * conversation was lost and must be rebuilt from the turns. Threads clear when the page reloads.
 */
import { create } from "zustand";
import { GEMMA } from "./model";

/** Tokens kept free for the answer, so an answer is not cut off at the window's edge. */
export const ANSWER_RESERVE = 400;
/** Characters of new passages in a follow-up, at most. The first question may use more. */
export const FOLLOW_UP_CHARS = 2500;
/** Characters of passages in the first question, at most. */
export const FIRST_CHARS = 6000;
/** Characters per token, the estimate sourceText uses too. */
export const CHARS_PER_TOKEN = 3.9;
/** Below this many characters of room, no passage fits, so the thread is full. */
export const MIN_CHARS = 300;

export interface Turn {
  question: string;
  answer: string;
  /** The coverage line for this turn, or null when it used the whole text. */
  note: string | null;
  /** The passages sent with this turn. */
  sources: string[];
  /** The PDF pages named in the answer's citations, in page order. */
  pages: number[];
  /** True when Stop ended this answer early. */
  stopped: boolean;
  /** The fingerprint of the item's text the answer was drawn from. A different one means the item changed since. */
  textKey: string;
  /** The text of each article paragraph the answer was given, by number, so a citation can still find it if the article moved. */
  quotes: Record<number, string>;
}

export interface Thread {
  turns: Turn[];
  /** Tokens in the model's conversation after the last answer, as the engine counted them. */
  tokens: number;
  /** The positions of the item's passages already sent, so a follow-up brings new ones. */
  sent: number[];
  /** True when the model's conversation was lost (Stop, a model unload, or a changed item) and must be rebuilt from the turns. */
  needsRebuild: boolean;
  /** The fingerprint of the item's text the thread is about; null before its first answer. */
  textKey: string | null;
}

const EMPTY: Thread = { turns: [], tokens: 0, sent: [], needsRebuild: false, textKey: null };

/**
 * The item's text as the thread knows it. If it changed (the article was saved again), the passages
 * in the conversation are for the old text, so the conversation is rebuilt from the turns, and the
 * passages are sent again for the new text. The old turns stay, with their own paragraph quotes.
 */
export function syncText(key: string, textKey: string): void {
  const t = threadOf(key);
  if (t.textKey === textKey) return;
  put(key, { ...t, textKey, sent: [], needsRebuild: t.needsRebuild || t.turns.length > 0 });
}

export const useThreads = create<{ threads: Record<string, Thread> }>(() => ({ threads: {} }));

export const threadOf = (key: string): Thread => useThreads.getState().threads[key] ?? EMPTY;

const put = (key: string, t: Thread) => useThreads.setState((s) => ({ threads: { ...s.threads, [key]: t } }));

/** Tokens left in the window for passages and the question, after the answer's reserve. */
export function roomTokens(t: Thread): number {
  return GEMMA.contextTokens - t.tokens - ANSWER_RESERVE;
}

/** Characters of passages the next question may bring. Zero means the thread is full. */
export function passageBudget(t: Thread): number {
  const want = t.turns.length === 0 ? FIRST_CHARS : FOLLOW_UP_CHARS;
  const fits = Math.floor(roomTokens(t) * CHARS_PER_TOKEN);
  const budget = Math.min(want, fits);
  return budget >= MIN_CHARS ? budget : 0;
}

/**
 * Record one answered turn. `tokens` is the conversation's size after it (0 when the engine did not
 * count, as after a Stop). `ended` means Stop ended the conversation, so the next question rebuilds it.
 * `rebuilt` means this turn ran in a conversation rebuilt from the turns: the passages sent earlier
 * are no longer in it, so only this turn's passages count as sent.
 */
export function addTurn(key: string, turn: Turn, tokens: number, sent: number[], ended: boolean, rebuilt = false): void {
  const t = threadOf(key);
  put(key, {
    turns: [...t.turns, turn],
    tokens: tokens > 0 ? tokens : t.tokens,
    sent: rebuilt ? [...new Set(sent)] : [...new Set([...t.sent, ...sent])],
    needsRebuild: ended,
    textKey: t.textKey,
  });
}

/** The passages a question may skip: all the ones sent so far, unless the conversation was rebuilt and lost them. */
export function skippable(t: Thread): Set<number> {
  return new Set(t.needsRebuild ? [] : t.sent);
}

/** The model's conversation for this thread is gone: the next question rebuilds it from the turns. */
export function markRebuild(key: string): void {
  const t = threadOf(key);
  if (t.turns.length > 0 || t.tokens > 0) put(key, { ...t, needsRebuild: true });
}

/** The model was unloaded, which took every conversation with it. Turns are kept. */
export function markAllRebuild(): void {
  for (const key of Object.keys(useThreads.getState().threads)) markRebuild(key);
}

/** Start a new thread for this item. */
export function clearThread(key: string): void {
  useThreads.setState((s) => {
    const threads = { ...s.threads };
    delete threads[key];
    return { threads };
  });
}

/** The model was removed from the device, so no thread survives. */
export function clearAllThreads(): void {
  useThreads.setState({ threads: {} });
}
