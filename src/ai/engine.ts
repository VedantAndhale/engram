/*
 * The page's side of the model: download it, load it into a worker, and run one request at a time.
 * Screens read `useAiStatus` to show what is happening; they call the functions here to act.
 */
import { create } from "zustand";
import { GEMMA, deleteModel, downloadModel, modelCached, readModel, webGpuAvailable, type DownloadProgress } from "./model";
import { clearAllThreads, markAllRebuild } from "./thread";

/** checking: looking at the device. unsupported: no WebGPU. absent: not downloaded. ready: downloaded, not in memory. */
export type Phase = "checking" | "unsupported" | "absent" | "downloading" | "ready" | "loading" | "loaded";

export interface AiStatus {
  phase: Phase;
  progress?: DownloadProgress;
  /** The last thing that went wrong, shown until the next action. */
  message?: string;
}

export const useAiStatus = create<AiStatus>(() => ({ phase: "checking" }));

type Reply =
  | { type: "loaded" }
  | { type: "token"; id: number; text: string }
  | { type: "done"; id: number; tokens?: number; cancelled?: boolean; threadEnded?: boolean }
  | { type: "error"; id: number | null; message: string };

/** What one request produced. `tokens` is the thread's conversation size afterwards (0 when not counted). */
export interface Outcome {
  text: string;
  tokens: number;
  /** Stop ended the answer early. */
  cancelled: boolean;
  /** The thread's conversation was dropped, so it must be rebuilt from its turns before the next question. */
  threadEnded: boolean;
}

/** The thread a request belongs to. Its turns rebuild the conversation when the engine has none, or when `rebuild` is set. */
export interface ThreadRef {
  key: string;
  turns: { question: string; answer: string }[];
  rebuild: boolean;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

let worker: Worker | null = null;
const listeners = new Set<(reply: Reply) => void>();
let loading: Promise<void> | null = null;
let nextId = 1;
/** Requests run one after another: the engine holds one conversation at a time. */
let queue: Promise<unknown> = Promise.resolve();

function startWorker(): Worker {
  if (!worker) {
    // A classic worker, because the LiteRT-LM runtime loads its WASM with importScripts (see vite.config.ts).
    worker = new Worker(new URL("./gemma.worker.ts", import.meta.url));
    worker.onmessage = (e: MessageEvent<Reply>) => listeners.forEach((listen) => listen(e.data));
    worker.onerror = (e) => listeners.forEach((listen) => listen({ type: "error", id: null, message: e.message || "The model stopped unexpectedly." }));
  }
  return worker;
}

/** Work out what this device can do and what is already downloaded. */
export async function refresh(): Promise<void> {
  const phase = useAiStatus.getState().phase;
  if (phase === "downloading" || phase === "loading" || phase === "loaded") return;
  if (!(await webGpuAvailable())) return useAiStatus.setState({ phase: "unsupported" });
  useAiStatus.setState({ phase: (await modelCached()) ? "ready" : "absent" });
}

let downloadCtl: AbortController | null = null;

/**
 * Download the pinned model. It lives in this module, not in a dialog, so it keeps going when the
 * dialog closes and Stop works from any later visit. A stopped or broken download leaves no partial file.
 */
export async function download(): Promise<void> {
  if (useAiStatus.getState().phase === "downloading") return;
  const ctl = new AbortController();
  downloadCtl = ctl;
  useAiStatus.setState({ phase: "downloading", progress: { received: 0, total: GEMMA.bytes }, message: undefined });
  // A network chunk can arrive many times a second, and each update re-renders the dialog. Show one update per 1%.
  let shown = 0;
  try {
    await downloadModel((progress) => {
      if (progress.received - shown < GEMMA.bytes / 100 && progress.received < progress.total) return;
      shown = progress.received;
      useAiStatus.setState({ progress });
    }, ctl.signal);
    useAiStatus.setState({ phase: "ready", progress: undefined });
  } catch (err) {
    useAiStatus.setState({ phase: "absent", progress: undefined, message: messageOf(err) });
  } finally {
    downloadCtl = null;
  }
}

/** Stop the download in progress. */
export function stopDownload(): void {
  downloadCtl?.abort();
}

/** Load the cached model into the worker. The first load after a restart takes minutes; later ones take seconds. */
export function load(): Promise<void> {
  if (useAiStatus.getState().phase === "loaded") return Promise.resolve();
  loading ??= (async () => {
    useAiStatus.setState({ phase: "loading", message: undefined });
    try {
      const model = await readModel();
      const w = startWorker();
      const wasmDir = new URL("litert/", document.baseURI).href;
      await new Promise<void>((resolve, reject) => {
        const listen = (reply: Reply) => {
          if (reply.type === "loaded") {
            listeners.delete(listen);
            resolve();
          } else if (reply.type === "error" && reply.id === null) {
            listeners.delete(listen);
            reject(new Error(reply.message));
          }
        };
        listeners.add(listen);
        w.postMessage({ type: "load", model, wasmDir });
      });
      useAiStatus.setState({ phase: "loaded" });
    } catch (err) {
      useAiStatus.setState({ phase: "ready", message: messageOf(err) });
      throw err;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Free the model's memory. The worker goes with its conversations, so every thread is marked to
 * rebuild from its turns the next time it is asked a question; the turns themselves are kept.
 */
export function unload(): void {
  if (useAiStatus.getState().phase !== "loaded") return;
  worker?.terminate();
  worker = null;
  listeners.clear();
  markAllRebuild();
  useAiStatus.setState({ phase: "ready" });
}

/** Remove the weights from this device. No thread survives, since their turns were answered by this model. */
export async function removeModel(): Promise<void> {
  unload();
  clearAllThreads();
  await deleteModel();
  useAiStatus.setState({ phase: "absent", message: undefined });
}

/** Forget a thread's conversation in the engine, when the reader starts that thread again. */
export function dropThread(key: string): void {
  worker?.postMessage({ type: "drop", key });
}

/**
 * Write an answer to `prompt`, passing each piece of text to `onToken` as it arrives. Stopping
 * with `signal` keeps the text written so far. With `thread`, the answer continues that thread's
 * conversation, and the outcome says whether Stop ended it.
 */
export function generate(prompt: string, onToken: (text: string) => void, signal?: AbortSignal, thread?: ThreadRef): Promise<Outcome> {
  const run = queue.then(async () => {
    await load();
    const w = startWorker();
    const id = nextId++;
    let text = "";
    return new Promise<Outcome>((resolve, reject) => {
      const cancel = () => w.postMessage({ type: "cancel", id });
      const listen = (reply: Reply) => {
        if (reply.type === "token" && reply.id === id) {
          text += reply.text;
          onToken(reply.text);
        } else if (reply.type === "done" && reply.id === id) {
          finish();
          resolve({ text, tokens: reply.tokens ?? 0, cancelled: reply.cancelled ?? false, threadEnded: reply.threadEnded ?? false });
        } else if (reply.type === "error" && reply.id === id) {
          finish();
          reject(new Error(reply.message));
        }
      };
      const finish = () => {
        listeners.delete(listen);
        signal?.removeEventListener("abort", cancel);
      };
      listeners.add(listen);
      signal?.addEventListener("abort", cancel);
      if (signal?.aborted) cancel();
      w.postMessage({ type: "generate", id, prompt, thread });
    });
  });
  queue = run.catch(() => undefined);
  return run;
}
