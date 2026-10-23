/**
 * Where the app is served from, with no trailing slash: "" at a domain root (the hosted site), or "/repo"
 * when built with BASE_PATH for a subfolder. Every address the app writes starts with it. Node's test
 * runner has no import.meta.env, so it reads as "" there.
 */
export const APP_BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/+$/, "");
