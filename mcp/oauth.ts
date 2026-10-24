import { recordSignup } from "./signups.js";
import { seal, unseal } from "./seal.js";
import { REFRESH_TTL_MS, accessTtlMs, clientFor, refreshable, signInMode, type SignInMode } from "./oauth-config.js";

/*
 * Sign in with GitHub, for the Engram app (login below) and for MCP clients, with no database.
 * The app gets a GitHub token back to sync with. MCP clients expect an OAuth server
 * that lets them register themselves; GitHub doesn't, so this one stands in front of it:
 *
 *   client → /authorize → consent page here → GitHub → /callback → client (with a code)
 *   client → /token (code + PKCE verifier) → access token
 *
 * Everything carried between steps is sealed (see seal.ts). The access token wraps the
 * GitHub token, so it is useless anywhere but this server, and nothing is stored. Access tokens
 * last 30 days, then the client signs in again. /revoke ends one sign-in (the app's on one
 * device, or one agent's) at GitHub; revoking Engram in GitHub's settings (Applications →
 * Authorized OAuth Apps) ends every session.
 */

/** Private folder repos need GitHub's "repo" scope; OAuth Apps have no read-only scope for them. */
const GITHUB_SCOPE = "repo";
/** The app also reads the primary email, for the sign-up list (mcp/signups.ts). MCP clients don't get it. */
const APP_SCOPE = "repo user:email";
const TOKEN_PREFIX = "eg1.";
const MINUTE = 60_000;

interface ClientData {
  redirectUris: string[];
  name?: string;
}
interface Pending {
  clientName?: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  /** Which registered client asked (a hash of its client_id): only it may redeem the code. */
  clientKey: string;
  /** Set once the person approves: the same value goes into a cookie in their browser only. */
  browser?: string;
}
/** Sign-in for the Engram app itself: it returns to the app, never to a client's address. */
interface AppPending {
  app: true;
  returnTo: string;
  nonce: string;
}

export const origin = (req: Request) => process.env.PUBLIC_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
export const resourceUrl = (req: Request) => `${origin(req)}/api/mcp`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

/** A short, fixed-size stand-in for a client_id (which is a whole sealed registration). */
async function clientKey(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
  return Buffer.from(digest).toString("base64url").slice(0, 22);
}

/** A token or revoke request's fields, sent as a form or as JSON. Null if the body can't be read. */
async function bodyParams(req: Request): Promise<URLSearchParams | null> {
  const raw = await req.text().catch(() => null);
  if (raw === null) return null;
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new URLSearchParams(raw);
  try {
    const body: unknown = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return new URLSearchParams(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return null;
  }
}

const CONSENT_COOKIE = "engram_consent";

/** A request this site's own pages made. Browsers send Sec-Fetch-Site; older ones only Origin. */
function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  return req.headers.get("origin") === origin(req);
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function protectedResource(req: Request) {
  return json({
    resource: resourceUrl(req),
    authorization_servers: [origin(req)],
    bearer_methods_supported: ["header"],
    resource_name: "Engram",
  });
}

export function authorizationServer(req: Request) {
  const o = origin(req);
  return json({
    issuer: o,
    authorization_endpoint: `${o}/api/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    revocation_endpoint: `${o}/api/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

function okRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    // Native apps' own schemes (vscode://, cursor://…); never ones a browser would run.
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "blob:", "vbscript:"].includes(u.protocol);
  } catch {
    return false;
  }
}

/** Dynamic client registration: the client id is the registration itself, sealed. */
export async function register(req: Request) {
  const body = (await req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every(okRedirectUri)) return oauthError("invalid_redirect_uri", "Give one to ten redirect URIs: https, a native app scheme, or http on localhost.");
  const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
  const clientId = await seal("client", { redirectUris: uris, name } satisfies ClientData);
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

/**
 * Step 1: check the request and ask the person. The page is shown every time, because GitHub
 * skips its own screen once Engram is authorized, and anyone can register a client: without
 * this, a link could hand someone else's library to a stranger's redirect address.
 */
export async function authorize(req: Request) {
  const params = req.method === "POST" ? new URLSearchParams(await req.text()) : new URL(req.url).searchParams;
  if (req.method === "POST") {
    // Step 2: they said yes; off to GitHub with the request sealed into the state. Only this
    // page's own form may say yes: another site's form would approve for whoever visits it.
    if (!sameOrigin(req)) return page("Connect from your app", "<p>Start connecting from your app, then approve on Engram's page.</p>", 403);
    const pending = await unseal<Pending>("consent", params.get("pending") ?? "");
    if (!pending) return page("This sign-in link expired", "<p>Go back to your app and connect again.</p>", 400);
    // The approval is tied to this browser, so a state copied from someone else's flow is useless here.
    const browser = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const res = await toGitHub(req, { ...pending, browser } satisfies Pending);
    res.headers.append("Set-Cookie", `${CONSENT_COOKIE}=${browser}; Path=/api/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
    return res;
  }

  const clientId = params.get("client_id") ?? "";
  const client = await unseal<ClientData>("client", clientId);
  const redirectUri = params.get("redirect_uri") ?? client?.redirectUris[0] ?? "";
  // Errors are shown here, never sent to the return address: anyone can register any https
  // address, so an error sent there would let a link on Engram's domain lead anywhere.
  if (!client) return page("Unknown app", "<p>This app isn't registered with Engram. Remove the server from your app and add it again.</p>", 400);
  if (!client.redirectUris.includes(redirectUri)) return page("Wrong return address", "<p>The app asked to return to an address it didn't register.</p>", 400);
  if (params.get("response_type") !== "code") return page("Can't connect this app", "<p>The app asked for a kind of sign-in Engram doesn't offer (only response_type=code).</p>", 400);
  const challenge = params.get("code_challenge");
  if (!challenge || params.get("code_challenge_method") !== "S256") return page("Can't connect this app", "<p>The app didn't use PKCE with S256, which Engram requires.</p>", 400);

  // Sealed as "consent", not "state": it must come back through the form, never straight from GitHub.
  const pending = await seal(
    "consent",
    { clientName: client.name, redirectUri, state: params.get("state") ?? undefined, challenge, clientKey: await clientKey(clientId) } satisfies Pending,
    10 * MINUTE,
  );
  const who = esc(client.name || "An app");
  const to = new URL(redirectUri);
  const dest = to.protocol === "http:" || to.protocol === "https:" ? to.host : to.protocol.slice(0, -1);
  return page(
    "Connect to Engram",
    `<p><strong>${who}</strong> wants to use your Engram library: read your notes, highlights and saved items, and send things to your inbox for you to accept.</p>
<p>It will reach your library through <strong>${esc(dest)}</strong>. Only continue if you started this from that app.</p>
<p class="small">Next, GitHub asks you to authorize Engram. Agents never change your items: what they send waits in your inbox until you accept it. Access lasts 30 days, and you can revoke it any time in GitHub → Settings → Applications.</p>
<form method="post" action="${esc(origin(req))}/api/oauth/authorize">
  <input type="hidden" name="pending" value="${esc(pending)}">
  <button type="submit">Continue with GitHub</button>
</form>`,
  );
}

async function toGitHub(req: Request, pending: Record<string, unknown>, scope = GITHUB_SCOPE) {
  const mode = signInMode(process.env);
  const client = clientFor(process.env, mode);
  if (!client) {
    const name = mode === "app" ? "GITHUB_APP_CLIENT_ID" : "GITHUB_CLIENT_ID";
    return page("Not set up", `<p>This server has no GitHub ${mode === "app" ? "App" : "OAuth App"} configured (${name}).</p>`, 500);
  }
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", client.id);
  gh.searchParams.set("redirect_uri", `${origin(req)}/api/oauth/callback`);
  // GitHub Apps take their permissions from the App itself, so only the OAuth App sends a scope.
  if (mode === "oauth") gh.searchParams.set("scope", scope);
  gh.searchParams.set("state", await seal("state", pending, 10 * MINUTE));
  return redirect(gh.toString());
}

/**
 * "Sign in with GitHub" in the Engram app. It may only return to this same site, so there is no
 * open redirect, and the app's nonce comes back with the token so the app accepts only a sign-in
 * it started itself.
 */
export async function login(req: Request) {
  const params = new URL(req.url).searchParams;
  const nonce = params.get("nonce") ?? "";
  let returnTo: URL;
  try {
    returnTo = new URL(params.get("return") ?? `${origin(req)}/`);
  } catch {
    return page("Bad sign-in link", "<p>Open Engram and choose Sign in with GitHub again.</p>", 400);
  }
  if (returnTo.origin !== origin(req) || !/^[\w-]{16,128}$/.test(nonce)) return page("Bad sign-in link", "<p>Open Engram and choose Sign in with GitHub again.</p>", 400);
  returnTo.hash = "";
  returnTo.search = "";
  return toGitHub(req, { app: true, returnTo: returnTo.toString(), nonce } satisfies AppPending, APP_SCOPE);
}

/** The app reads its sign-in from the fragment, which browsers never send to a server. */
function backToApp(pending: AppPending, result: Record<string, string>) {
  return redirect(`${pending.returnTo}#engram-auth&${new URLSearchParams({ ...result, nonce: pending.nonce })}`);
}

/** Step 3: GitHub sends the person back; trade its code for a token, hand the client our own code. */
export async function callback(req: Request) {
  const params = new URL(req.url).searchParams;
  const pending = await unseal<Pending | AppPending>("state", params.get("state") ?? "");
  if (!pending) return page("This sign-in link expired", "<p>Go back to your app and connect again.</p>", 400);
  const code = params.get("code");

  if ("app" in pending) {
    if (!code) return backToApp(pending, { error: "GitHub sign-in was cancelled." });
    const r = await exchange(req, code);
    if ("token" in r) await recordSignup(r.token);
    if (!("token" in r)) return backToApp(pending, { error: r.error });
    return backToApp(pending, await appResult(r));
  }

  // Only the browser that approved may finish. Without this, a state from an attacker's own run
  // could be handed to someone GitHub no longer asks, and their library would go to the attacker.
  if (!pending.browser || cookie(req, CONSENT_COOKIE) !== pending.browser) {
    return page("Connect from your app", "<p>This approval didn't start in this browser. Go back to your app and connect again.</p>", 403);
  }
  const back = new URL(pending.redirectUri);
  if (pending.state) back.searchParams.set("state", pending.state);
  if (!code) {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "GitHub sign-in was cancelled.");
    return redirect(back.toString());
  }
  const r = await exchange(req, code);
  if (!("token" in r)) return page("GitHub sign-in failed", `<p>${esc(r.error)}</p>`, 502);
  // A sealed code can't be marked as used, so it lives one minute and only its own client may redeem it.
  const sealed: Code = { t: r.token, c: pending.clientName, k: pending.clientKey, challenge: pending.challenge, redirectUri: pending.redirectUri };
  if (refreshable(signInMode(process.env))) {
    if (r.refresh) sealed.r = r.refresh;
    if (r.expiresIn) sealed.expires = r.expiresIn;
  }
  back.searchParams.set("code", await seal("code", sealed, MINUTE));
  return redirect(back.toString());
}

/** GitHub's code for a GitHub token. Needs the client secret, which is why this runs here. */
async function exchange(
  req: Request,
  code: string,
): Promise<{ token: string; refresh?: string; expiresIn?: number } | { error: string }> {
  const client = clientFor(process.env, signInMode(process.env));
  if (!client) return { error: "Sign-in is not set up on the server." };
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: client.id,
      client_secret: client.secret,
      code,
      redirect_uri: `${origin(req)}/api/oauth/callback`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!body.access_token) return { error: body.error_description ?? "GitHub didn't return a token." };
  const out: { token: string; refresh?: string; expiresIn?: number } = { token: body.access_token };
  // Only GitHub App tokens come with these two, so they stay out of the OAuth result.
  if (body.refresh_token) out.refresh = body.refresh_token;
  if (typeof body.expires_in === "number" && body.expires_in > 0) out.expiresIn = body.expires_in;
  return out;
}

type Code = {
  t: string;
  c?: string;
  k: string;
  challenge: string;
  redirectUri: string;
  /** GitHub's refresh token: only in app mode. */
  r?: string;
  /** Seconds the GitHub access token lives: only in app mode. */
  expires?: number;
};

/** The web app's fragment: the token, and in app mode a sealed refresh token and the token's lifetime. */
async function appResult(r: { token: string; refresh?: string; expiresIn?: number }): Promise<Record<string, string>> {
  const out: Record<string, string> = { token: r.token };
  if (!refreshable(signInMode(process.env))) return out;
  if (r.refresh) out.refresh = await seal("refresh", { r: r.refresh }, REFRESH_TTL_MS);
  if (r.expiresIn) out.expires = String(r.expiresIn);
  return out;
}

/** Trades GitHub's refresh token for a new access token AND a new refresh token (GitHub rotates both). */
async function refreshWith(
  refreshToken: string,
): Promise<{ token: string; refresh: string; expiresIn: number } | { error: string; transient: boolean }> {
  const client = clientFor(process.env, signInMode(process.env));
  if (!client) return { error: "Sign-in is not set up on the server.", transient: false };
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: client.id,
      client_secret: client.secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  // GitHub answers a dead refresh token with an error body, so read the body whatever the status.
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!body.access_token || !body.refresh_token) {
    // A refusal is GitHub saying this refresh token is no good. A server error, a rate limit, or a reply with no
    // error in it is GitHub having a bad moment: the sign-in is still good, so it is tried again later.
    const refused = res.status < 500 && res.status !== 429 && typeof body.error === "string";
    return { error: body.error_description ?? "GitHub refused the refresh.", transient: !refused };
  }
  return {
    token: body.access_token,
    refresh: body.refresh_token,
    expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 28800,
  };
}

/** Opens a sealed refresh token. Null for anything missing, expired or altered. */
async function openRefresh(value: string | null | undefined): Promise<{ r: string; c?: string; k?: string } | null> {
  if (!value) return null;
  const data = await unseal<{ r?: string; c?: string; k?: string }>("refresh", value);
  return data?.r ? { r: data.r, c: data.c, k: data.k } : null;
}

/** The /token response. The refresh token is bound to the client (k) it was issued to. */
async function issueTokens(
  mode: SignInMode,
  grant: { t: string; c?: string; k: string; r?: string; expires?: number },
): Promise<Response> {
  const ttl = accessTtlMs(mode, grant.expires);
  const body: Record<string, unknown> = {
    access_token: TOKEN_PREFIX + (await seal("token", { t: grant.t, c: grant.c }, ttl)),
    token_type: "Bearer",
    expires_in: Math.floor(ttl / 1000),
  };
  if (grant.r) body.refresh_token = await seal("refresh", { r: grant.r, c: grant.c, k: grant.k }, REFRESH_TTL_MS);
  return json(body);
}

/** The MCP client's refresh_token grant (app mode only). */
async function refreshGrant(p: URLSearchParams, mode: SignInMode): Promise<Response> {
  if (!refreshable(mode)) return oauthError("unsupported_grant_type", "Refresh tokens need the GitHub App sign-in.");
  const old = await openRefresh(p.get("refresh_token"));
  if (!old) return oauthError("invalid_grant", "Connect again.");
  const clientId = p.get("client_id");
  if (!old.k || !clientId || (await clientKey(clientId)) !== old.k) {
    return oauthError("invalid_grant", "The refresh token was issued to another client.");
  }
  const fresh = await refreshWith(old.r);
  if ("error" in fresh) return oauthError("invalid_grant", "Connect again.");
  return issueTokens(mode, { t: fresh.token, c: old.c, k: old.k, r: fresh.refresh, expires: fresh.expiresIn });
}

/** Step 4: the client proves it started the flow (PKCE) and gets its access token. */
export async function token(req: Request) {
  const p = await bodyParams(req);
  if (!p) return oauthError("invalid_request", "Send the request as a form or a JSON object.");
  const mode = signInMode(process.env);
  if (p.get("grant_type") === "refresh_token") return refreshGrant(p, mode);
  if (p.get("grant_type") !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Use authorization_code, or refresh_token with the GitHub App sign-in.");
  }
  const code = await unseal<Code>("code", p.get("code") ?? "");
  if (!code) return oauthError("invalid_grant", "The code is invalid or expired.");
  const clientId = p.get("client_id");
  if (!clientId || !code.k || (await clientKey(clientId)) !== code.k) return oauthError("invalid_grant", "The code was issued to another client.");
  if (p.get("redirect_uri") && p.get("redirect_uri") !== code.redirectUri) return oauthError("invalid_grant", "redirect_uri doesn't match.");
  const verifier = p.get("code_verifier") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  if (!verifier || Buffer.from(digest).toString("base64url") !== code.challenge) return oauthError("invalid_grant", "PKCE check failed.");
  return issueTokens(mode, { t: code.t, c: code.c, k: code.k, r: code.r, expires: code.expires });
}

/**
 * Token revocation (RFC 7009): ends one sign-in at GitHub. Takes the app's GitHub token or an
 * agent's access token (whose GitHub token it unwraps), so signing out on one device or
 * disconnecting one agent leaves the others alone. As the RFC says, any token gets a 200.
 */
export async function revoke(req: Request) {
  const p = await bodyParams(req);
  if (!p) return oauthError("invalid_request", "Send the request as a form or a JSON object.");
  let t = p.get("token") ?? "";
  if (t.startsWith(TOKEN_PREFIX)) t = (await unseal<{ t: string }>("token", t.slice(TOKEN_PREFIX.length)))?.t ?? "";
  if (/^gh[opsu]_[A-Za-z0-9_]{20,255}$/.test(t) && !(await revokeAtGitHub(t))) {
    return oauthError("temporarily_unavailable", "GitHub didn't confirm the sign-out. Try again.", 503);
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}

/** The web app renews its App sign-in: its sealed refresh token in, a new token and a new refresh token out. */
export async function refresh(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  if (!refreshable(signInMode(process.env))) return json({ error: "invalid_grant" }, 401);
  const p = await bodyParams(req);
  const old = await openRefresh(p?.get("refresh"));
  if (!old) return json({ error: "invalid_grant" }, 401);
  const fresh = await refreshWith(old.r);
  // 503 for GitHub's bad moments, so the app retries; 401 only when GitHub refused this refresh token.
  if ("error" in fresh) return fresh.transient ? json({ error: "temporarily_unavailable" }, 503) : json({ error: "invalid_grant" }, 401);
  return json({
    token: fresh.token,
    refresh: await seal("refresh", { r: fresh.refresh }, REFRESH_TTL_MS),
    expires_in: fresh.expiresIn,
  });
}

/** GitHub's own revocation of one token of this sign-in's client. Needs the client secret. */
async function revokeAtGitHub(githubToken: string): Promise<boolean> {
  const client = clientFor(process.env, signInMode(process.env));
  if (!client) return false;
  const id = client.id;
  const secret = client.secret;
  const res = await fetch(`https://api.github.com/applications/${encodeURIComponent(id)}/token`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/json",
      "User-Agent": "Engram",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ access_token: githubToken }),
  }).catch(() => null);
  // 404/422: GitHub doesn't know the token (already revoked, or another app's), so it's done.
  return !!res && (res.status === 204 || res.status === 404 || res.status === 422);
}

/**
 * Who is calling: the GitHub token behind the request, and the app's name as it registered
 * (recorded on inbox files). Only access tokens from this server's sign-in are accepted.
 */
export async function caller(req: Request): Promise<{ token: string; agent?: string } | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m?.[1].startsWith(TOKEN_PREFIX)) return null;
  const sealed = await unseal<{ t: string; c?: string }>("token", m[1].slice(TOKEN_PREFIX.length));
  return sealed ? { token: sealed.t, agent: sealed.c } : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Engram</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f6f1e7;color:#2b2620;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{background:#fffdf8;border:1px solid #e4dccb;border-radius:12px;padding:28px;max-width:440px}
h1{font-size:20px;margin:0 0 12px}.small{font-size:13px;color:#6b6257}
button{font:inherit;background:#2b2620;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer;margin-top:8px}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The consent button must never be clickable through someone else's frame.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}
