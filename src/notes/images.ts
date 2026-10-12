/*
 * Pictures in notes. A pasted screenshot is shrunk and kept inside the note's own text, as a Markdown
 * picture whose address is the picture's data. It travels with the note in its file, to every device,
 * with no second file to keep in step.
 */

/** The longest side of a kept picture, in pixels. A screenshot stays readable at this size. */
const LONGEST = 1280;
const QUALITY = 0.85;
const PICTURE_SOURCE = String.raw`!\[([^\]]*)\]\((data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)\)`;

/** The picture in a paste, if the paste holds one. */
export function pictureIn(data: DataTransfer | null): File | null {
  const item = Array.from(data?.items ?? []).find((i) => i.kind === "file" && i.type.startsWith("image/"));
  return item?.getAsFile() ?? null;
}

/** The picture, shrunk and as a JPEG, written as Markdown with the picture inside it. */
export async function pictureMarkdown(file: Blob, alt = "screenshot"): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONGEST / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read the picture");
  // A transparent picture would turn black as a JPEG, so it sits on white first.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return `![${alt.replace(/[[\]]/g, "")}](${canvas.toDataURL("image/jpeg", QUALITY)})`;
}

/** Text and pictures in the order they appear, for showing a note. */
export type Piece = { text: string } | { src: string; alt: string };

export function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(PICTURE_SOURCE, "g"))) {
    const at = m.index ?? 0;
    if (at > last) pieces.push({ text: text.slice(last, at) });
    pieces.push({ alt: m[1], src: m[2] });
    last = at + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

/** The text with each picture replaced by a word, for search and for previews. */
export const withoutPictures = (text: string) => text.replace(new RegExp(PICTURE_SOURCE, "g"), "[picture]");
