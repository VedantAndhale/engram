/*
 * Sealed strings: AES-GCM with a key only the server holds. They let OAuth stay stateless, since
 * everything the server must remember between two requests rides along in the request itself,
 * unreadable and tamper-proof to anyone else. Each seal names its kind, so one kind can't be
 * passed off as another.
 */

export type SealKind = "client" | "consent" | "state" | "code" | "token" | "refresh";

let keyPromise: Promise<CryptoKey> | null = null;

function key(): Promise<CryptoKey> {
  const secret = process.env.MCP_SECRET;
  if (!secret || secret.length < 32) throw new Error("MCP_SECRET must be set to at least 32 random characters.");
  keyPromise ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(secret))
    .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  return keyPromise;
}

export async function seal(kind: SealKind, data: Record<string, unknown>, ttlMs?: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ k: kind, x: ttlMs ? Date.now() + ttlMs : undefined, d: data }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return Buffer.from(out).toString("base64url");
}

/** The sealed data, or null if it was forged, altered, expired or of another kind. */
export async function unseal<T>(kind: SealKind, sealed: string): Promise<T | null> {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await key(), bytes.subarray(12));
    const { k, x, d } = JSON.parse(new TextDecoder().decode(plain)) as { k: string; x?: number; d: T };
    if (k !== kind || (x !== undefined && Date.now() > x)) return null;
    return d;
  } catch {
    return null;
  }
}
