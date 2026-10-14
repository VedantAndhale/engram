// A short, stable id for an imported book or highlight. Importing the same file
// twice produces the same ids, so a re-import updates instead of duplicating.
export async function refId(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 24);
}