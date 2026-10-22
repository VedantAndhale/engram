/*
 * Gemma 4 E2B for the browser: where the weights come from, and how they are kept on this device.
 * The weights are downloaded once from Hugging Face into the browser's cache storage. Nothing is
 * sent to Engram, and nothing about the model goes into the folder or to GitHub.
 */

export const GEMMA = {
  name: "Gemma 4 E2B",
  /** Pinned to one commit of the litert-community repo, so an update there cannot change what runs here. */
  url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1/gemma-4-E2B-it-web.litertlm",
  /** Exact size of the pinned file, checked before the download is kept. */
  bytes: 2008432640,
  cacheName: "engram-ai-models",
  /** The context window the engine is loaded with: prompt and answer together. */
  contextTokens: 4096,
} as const;

export interface DownloadProgress {
  received: number;
  total: number;
}

/** The model runs on the GPU, so the device needs a WebGPU adapter. */
export async function webGpuAvailable(): Promise<boolean> {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** True when the whole pinned file is in cache storage. */
export async function modelCached(): Promise<boolean> {
  if (!("caches" in self)) return false;
  const hit = await (await caches.open(GEMMA.cacheName)).match(GEMMA.url);
  return !!hit && hit.headers.get("content-length") === String(GEMMA.bytes);
}

/**
 * Download the pinned file into cache storage. `cache: "no-store"` keeps the browser's HTTP cache
 * from holding a second copy of two gigabytes. A download that stops short is removed again.
 */
export async function downloadModel(onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(GEMMA.url, { cache: "no-store", signal });
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || GEMMA.bytes;
  if (total !== GEMMA.bytes) throw new Error("The file on Hugging Face is not the version Engram expects.");

  let received = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        onProgress({ received, total });
        controller.enqueue(chunk);
      },
    }),
  );
  const cache = await caches.open(GEMMA.cacheName);
  try {
    await cache.put(GEMMA.url, new Response(counted, { headers: { "content-length": String(total), "content-type": "application/octet-stream" } }));
  } catch (err) {
    await cache.delete(GEMMA.url).catch(() => undefined);
    if (signal?.aborted) throw new Error("The download was stopped.");
    if (err instanceof TypeError) throw new Error("The connection dropped during the download. Press Download to try again.");
    throw new Error("The model could not be stored on this device. Free some disk space and try again.");
  }
  if (!(await modelCached())) {
    await cache.delete(GEMMA.url).catch(() => undefined);
    throw new Error("The download did not finish. Press Download to try again.");
  }
}

/** The cached file as a Blob, which the engine reads in its worker. */
export async function readModel(): Promise<Blob> {
  const hit = await (await caches.open(GEMMA.cacheName)).match(GEMMA.url);
  if (!hit) throw new Error("The model is not on this device.");
  return hit.blob();
}

/** Remove the weights from this device. */
export async function deleteModel(): Promise<void> {
  await caches.delete(GEMMA.cacheName);
}
