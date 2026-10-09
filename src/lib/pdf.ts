import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf_viewer.mjs reads the core library from this global, so it must be set before the viewer loads.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

export { pdfjsLib };

const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

export function openPdf(data: ArrayBuffer) {
  return pdfjsLib.getDocument({
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    data: new Uint8Array(data.slice(0)),
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
  }).promise;
}

export type PDFDoc = Awaited<ReturnType<typeof openPdf>>;

/** Title, page count and a cover thumbnail, read once when a PDF is added. */
export async function inspectPdf(data: ArrayBuffer, fileName: string) {
  const pdf = await openPdf(data);
  try {
    let title = fileName.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim();
    try {
      const meta = await pdf.getMetadata();
      const t = (meta.info as { Title?: string })?.Title?.trim();
      if (t && t.length > 2 && !/^untitled|^microsoft word/i.test(t)) title = t;
    } catch {
      /* metadata is optional */
    }
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const thumb = canvas.toDataURL("image/jpeg", 0.82);
    return { title, pages: pdf.numPages, thumb };
  } finally {
    void pdf.loadingTask.destroy();
  }
}

/** Plain text of every page, for library-wide search. Yields between pages to keep the UI smooth. */
export async function extractText(pdf: PDFDoc, onPage: (page: number, text: string) => Promise<void>) {
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : ""))
      .join("")
      .replace(/[ \t]+/g, " ");
    await onPage(i, text);
    await new Promise((r) => setTimeout(r, 0));
  }
}
