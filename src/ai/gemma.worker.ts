/*
 * Runs the model off the page's main thread, so typing and scrolling stay smooth while it writes.
 * The page sends the cached file as a Blob and says where the WASM runtime is; the worker answers
 * with streamed text, one message per piece.
 *
 * A thread keeps one conversation here between questions. Stopping an answer ends that conversation
 * (the runtime cannot continue it), so the next question starts a new one from the thread's turns.
 */
import { Backend, Engine, loadLiteRtLm, type Conversation } from "@litert-lm/core";
import { GEMMA } from "./model";

/** One earlier question and its answer, used to rebuild a thread's conversation. */
interface Turn {
  question: string;
  answer: string;
}

type Request =
  | { type: "load"; model: Blob; wasmDir: string }
  | { type: "generate"; id: number; prompt: string; thread?: { key: string; turns: Turn[]; rebuild: boolean } }
  | { type: "cancel"; id: number }
  | { type: "drop"; key: string };

let engine: Promise<Engine> | null = null;
/** The request in progress, so Stop can reach its conversation. */
const running = new Map<number, Conversation>();
/** Requests the reader stopped, so their conversation is not kept. */
const stopped = new Set<number>();
/** One conversation per thread, kept between questions. */
const threads = new Map<string, Conversation>();

function loadEngine(model: Blob, wasmDir: string): Promise<Engine> {
  engine ??= (async () => {
    // The runtime's Emscripten glue finds its .wasm next to the worker script by default, which is
    // /assets/ here, so point it at the copied runtime folder before the glue loads.
    (self as unknown as { Module: object }).Module = { locateFile: (file: string) => wasmDir + file };
    await loadLiteRtLm(wasmDir);
    return Engine.create({
      model,
      backend: Backend.GPU_ARTISAN,
      mainExecutorSettings: { maxNumTokens: GEMMA.contextTokens },
    });
  })();
  return engine;
}

/**
 * The conversation for a thread. Without one, or when a rebuild is asked for, a new conversation
 * starts with the thread's earlier turns as its preface. The passages of those turns are not
 * repeated, so a rebuilt thread keeps the answers but not the text they were drawn from.
 */
async function threadConversation(e: Engine, key: string, turns: Turn[], rebuild: boolean): Promise<Conversation> {
  const kept = threads.get(key);
  if (kept && !rebuild) return kept;
  if (kept) await kept.delete().catch(() => undefined);
  const messages = turns.flatMap((t) => [
    { role: "user", content: t.question },
    { role: "assistant", content: t.answer },
  ]);
  const conversation = await e.createConversation({
    // Thinking adds long hidden reasoning before each answer; these features want the answer only.
    preface: { ...(messages.length > 0 ? { messages } : {}), extra_context: { enable_thinking: false } },
  });
  threads.set(key, conversation);
  return conversation;
}

async function generate(id: number, prompt: string, thread?: { key: string; turns: Turn[]; rebuild: boolean }) {
  if (!engine) throw new Error("The model is not loaded.");
  const e = await engine;
  const conversation = thread
    ? await threadConversation(e, thread.key, thread.turns, thread.rebuild)
    : await e.createConversation({
        // Thinking adds long hidden reasoning before each answer; these features want the answer only.
        preface: { extra_context: { enable_thinking: false } },
      });
  running.set(id, conversation);
  try {
    for await (const chunk of conversation.sendMessageStreaming(prompt)) {
      const content = chunk.content;
      if (typeof content === "string") {
        self.postMessage({ type: "token", id, text: content });
      } else if (content) {
        for (const part of content) {
          if (part.type === "text") self.postMessage({ type: "token", id, text: part.text });
        }
      }
    }
  } catch (err) {
    // The runtime ends a stopped answer with a "Task cancelled" error. A Stop is a normal end, not a failure.
    if (!stopped.has(id)) {
      running.delete(id);
      if (thread) threads.delete(thread.key);
      await conversation.delete().catch(() => undefined);
      throw err;
    }
  }
  running.delete(id);
  const wasStopped = stopped.delete(id);
  if (!thread) {
    await conversation.delete().catch(() => undefined);
    self.postMessage({ type: "done", id, cancelled: wasStopped });
    return;
  }
  if (wasStopped) {
    // The runtime cannot continue a stopped conversation, so it is dropped; the thread rebuilds it next time.
    threads.delete(thread.key);
    await conversation.delete().catch(() => undefined);
    self.postMessage({ type: "done", id, cancelled: true, threadEnded: true });
    return;
  }
  const tokens = await conversation.getTokenCount().catch(() => 0);
  self.postMessage({ type: "done", id, tokens });
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      await loadEngine(msg.model, msg.wasmDir);
      self.postMessage({ type: "loaded" });
    } else if (msg.type === "generate") {
      await generate(msg.id, msg.prompt, msg.thread);
    } else if (msg.type === "cancel") {
      stopped.add(msg.id);
      running.get(msg.id)?.cancel();
    } else {
      // A thread is started again: its conversation goes.
      const kept = threads.get(msg.key);
      threads.delete(msg.key);
      await kept?.delete().catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", id: "id" in msg ? msg.id : null, message });
  }
};
