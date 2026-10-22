/*
 * One answered turn of a thread, shared by the Ask dialog and by the notes beside an article. It picks
 * the passages, writes the prompt, runs the model, and records the turn, so both screens answer the
 * same way. The model is passed in, so a test can answer without one.
 */
import type { CiteKind, Paragraph } from "../reader/paragraphs";
import { paragraphsOf } from "../reader/paragraphs";
import { articlePassages, chunkText, pickPassages } from "./chunks";
import { coverageLine, labelsIn, type Coverage } from "./coverage";
import { QUICK_LABEL, type QuickAction } from "./dialog";
import type { Outcome, ThreadRef } from "./engine";
import { askPrompt, EXPLAIN_LIMIT, followUpPrompt, quickPrompt, sourceCut, summarizePrompt } from "./prompts";
import { addTurn, markRebuild, passageBudget, skippable, syncText, threadOf, type Thread, type Turn } from "./thread";

/** Runs the model: the engine's `generate`, or a stand-in in a test. */
export type Generate = (prompt: string, onToken: (piece: string) => void, signal?: AbortSignal, thread?: ThreadRef) => Promise<Outcome>;

/** What a thread is about: one item's text, cut into passages once, and the key its conversation lives under. */
export interface TurnContext {
  key: string;
  title: string;
  text: string;
  /** What a citation names: a PDF's page, an article's paragraph, or null when the item has neither. */
  cite: CiteKind | null;
  /** The article's paragraphs, numbered as the article view numbers them. Empty for anything else. */
  paragraphs: Paragraph[];
  chunks: string[];
  /** A fingerprint of the text, so a change since an answer can be told. */
  textKey: string;
}

/** A short fingerprint of the item's text, so a change since an answer can be told. */
export function fingerprint(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

/** The context for a thread over `text`. `page` is set for a PDF, `article` for a saved article. */
export function turnContext(input: { key: string; title: string; text: string; page?: boolean; article?: { markdown: boolean } }): TurnContext {
  const cite: CiteKind | null = input.page ? "page" : input.article ? "para" : null;
  const paragraphs = input.article ? paragraphsOf(input.text, input.article.markdown) : [];
  const chunks = input.article ? articlePassages(paragraphs) : chunkText(input.text);
  return { key: input.key, title: input.title, text: input.text, cite, paragraphs, chunks, textKey: fingerprint(input.text) };
}

/** The same item under another thread's key, so notes over one article share its passages. */
export const withKey = (ctx: TurnContext, key: string): TurnContext => ({ ...ctx, key });

export type TurnRequest =
  /** A question: the first of a thread, or a follow-up. */
  | { kind: "ask"; question: string }
  /** A one-click action on a selection. `context` is the sentence it sits in. */
  | { kind: "quick"; action: QuickAction; selection: string; context: string }
  | { kind: "summary" };

/** What it takes to answer a request: the prompt, and the turn as it will be recorded once the answer is in. */
export interface Built {
  prompt: string;
  turn: Omit<Turn, "answer" | "stopped">;
  /** The positions of the passages sent, so a follow-up brings new ones. */
  indexes: number[];
}

export const FULL = "This thread has used its room. Start a new thread to keep asking.";

/** How a quick action or a summary reads in the thread's earlier turns, which rebuild the model's conversation. */
export function askedOf(req: TurnRequest): string {
  if (req.kind === "ask") return req.question.trim();
  if (req.kind === "summary") return "Summarize this item.";
  const quote = req.selection.replace(/\s+/g, " ").trim();
  return `${QUICK_LABEL[req.action]}: “${quote.length > 160 ? `${quote.slice(0, 160)}…` : quote}”`;
}

/** The prompt and the turn's record for a request, or null when the thread has no room for a question. */
export function build(ctx: TurnContext, req: TurnRequest, thread: Thread): Built | null {
  const base = { question: askedOf(req), textKey: ctx.textKey, quotes: {} as Record<number, string> };
  if (req.kind === "summary") {
    const cut = sourceCut(ctx.text);
    const coverage: Coverage | null = cut.cut ? { kind: "summary", used: cut.used, total: cut.total } : null;
    return {
      prompt: summarizePrompt(ctx.title, ctx.text),
      turn: { ...base, note: coverage && coverageLine(coverage), sources: [], pages: [] },
      indexes: [],
    };
  }
  if (req.kind === "quick") {
    const cut = sourceCut(req.selection, EXPLAIN_LIMIT);
    const coverage: Coverage | null = cut.cut ? { kind: "explain", used: cut.used, total: cut.total } : null;
    return {
      prompt: quickPrompt(req.action, req.selection, ctx.title, req.context),
      turn: { ...base, note: coverage && coverageLine(coverage), sources: [req.selection], pages: [] },
      indexes: [],
    };
  }
  const limit = passageBudget(thread);
  if (limit === 0) return null;
  const asked = req.question.trim();
  const picked = pickPassages(asked, ctx.chunks, limit, ctx.text.trim().length, skippable(thread));
  const partial = picked.sent < picked.passages;
  const prompt =
    thread.turns.length === 0
      ? askPrompt(asked, picked.texts, ctx.title, partial, ctx.cite)
      : followUpPrompt(asked, picked.texts, ctx.title, partial, ctx.cite);
  const labels = labelsIn(picked.texts, ctx.cite ?? "page");
  const paragraphText = new Map(ctx.paragraphs.map((p) => [p.n, p.text]));
  const coverage: Coverage = { kind: "ask", picked, pages: labels, cite: ctx.cite ?? undefined };
  return {
    prompt,
    turn: {
      ...base,
      note: coverageLine(coverage),
      sources: picked.texts,
      pages: labels,
      quotes: Object.fromEntries(ctx.cite === "para" ? labels.map((n) => [n, paragraphText.get(n) ?? ""]) : []),
    },
    indexes: picked.indexes,
  };
}

/**
 * Answer one request in its thread. Each piece of the answer goes to `onToken` as it arrives. The turn is
 * recorded in the thread unless the reader stopped before any words came. Returns the message to show
 * when it could not answer, else null.
 */
export async function answerTurn(ctx: TurnContext, req: TurnRequest, generate: Generate, onToken: (piece: string) => void, signal?: AbortSignal): Promise<string | null> {
  // The item may have been saved again since the thread began: its passages then need sending again.
  syncText(ctx.key, ctx.textKey);
  const cur = threadOf(ctx.key);
  const built = build(ctx, req, cur);
  if (!built) return FULL;
  const rebuilt = cur.needsRebuild;
  try {
    const out = await generate(built.prompt, onToken, signal, {
      key: ctx.key,
      turns: cur.turns.map((t) => ({ question: t.question, answer: t.answer })),
      rebuild: cur.needsRebuild,
    });
    if (out.cancelled && out.text.trim() === "") {
      // Stopped before any words came: nothing to keep, but the conversation is gone and must be rebuilt.
      markRebuild(ctx.key);
      return "Stopped before the answer started. Ask again to continue.";
    }
    addTurn(ctx.key, { ...built.turn, answer: out.text, stopped: out.cancelled }, out.tokens, built.indexes, out.threadEnded, rebuilt);
    return null;
  } catch (err) {
    markRebuild(ctx.key);
    return err instanceof Error ? err.message : String(err);
  }
}
