import { seal, unseal } from "./seal.js";

/*
 * Sign in with GitHub, for the Engram app (login below) and for MCP clients, with no database.
 * The app gets a GitHub token back to sync with. MCP clients expect an OAuth server
 * that lets them register themselves; GitHub doesn't, so this one stands in front of it:
 *
 *   client → /authorize → consent page here → GitHub → /callback → client (with a code)
 *   client → /token (code + PKCE verifier) → access token
 *
 * Everything carried between steps is sealed (see seal.ts). The access token wraps the
 * GitHub token, so it is useless anywhere but this server, and nothing is stored: revoking
 * Engram in GitHub's settings (Applications → Authorized OAuth Apps) ends every session.
 */

/** Private folder repos need GitHub's "repo" scope; OAuth Apps have no read-only scope for them. */
const GITHUB_SCOPE = "repo";
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
    // Step 2: they said yes; off to GitHub with the request sealed into the state.
    const pending = await unseal<Pending>("state", params.get("pending") ?? "");
    if (!pending) return page("This sign-in link expired", "<p>Go back to your app and connect again.</p>", 400);
    return toGitHub(req, { ...pending });
  }

  const client = await unseal<ClientData>("client", params.get("client_id") ?? "");
  const redirectUri = params.get("redirect_uri") ?? client?.redirectUris[0] ?? "";
  // Until the redirect address is known good, errors are shown here, never sent there.
  if (!client) return page("Unknown app", "<p>This app isn't registered with Engram. Remove the server from your app and add it again.</p>", 400);
  if (!client.redirectUris.includes(redirectUri)) return page("Wrong return address", "<p>The app asked to return to an address it didn't register.</p>", 400);
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (params.get("state")) u.searchParams.set("state", params.get("state")!);
    return redirect(u.toString());
  };
  if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = params.get("code_challenge");
  if (!challenge || params.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required.");

  const pending = await seal("state", { clientName: client.name, redirectUri, state: params.get("state") ?? undefined, challenge } satisfies Pending, 10 * MINUTE);
  const who = esc(client.name || "An app");
  const to = new URL(redirectUri);
  const dest = to.protocol === "http:" || to.protocol === "https:" ? to.host : to.protocol.slice(0, -1);
  return page(
    "Connect to Engram",
    `<p><strong>${who}</strong> wants to use your Engram library: read your notes, highlights and saved items, and send things to your inbox for you to accept.</p>
<p>It will reach your library through <strong>${esc(dest)}</strong>. Only continue if you started this from that app.</p>
<p class="small">Next, GitHub asks you to authorize Engram. Agents never change your items: what they send waits in your inbox until you accept it. You can revoke access any time in GitHub → Settings → Applications.</p>
<form method="post" action="${esc(origin(req))}/api/oauth/authorize">
  <input type="hidden" name="pending" value="${esc(pending)}">
  <button type="submit">Continue with GitHub</button>
</form>`,
  );
}

async function toGitHub(req: Request, pending: Record<string, unknown>) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return page("Not set up", "<p>This server has no GitHub OAuth App configured (GITHUB_CLIENT_ID).</p>", 500);
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", clientId);
  gh.searchParams.set("redirect_uri", `${origin(req)}/api/oauth/callback`);
  gh.searchParams.set("scope", GITHUB_SCOPE);
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
  return toGitHub(req, { app: true, returnTo: returnTo.toString(), nonce } satisfies AppPending);
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
    return backToApp(pending, "token" in r ? { token: r.token } : { error: r.error });
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
  back.searchParams.set("code", await seal("code", { t: r.token, c: pending.clientName, challenge: pending.challenge, redirectUri: pending.redirectUri }, 5 * MINUTE));
  return redirect(back.toString());
}

/** GitHub's code for a GitHub token. Needs the client secret, which is why this runs here. */
async function exchange(req: Request, code: string): Promise<{ token: string } | { error: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin(req)}/api/oauth/callback`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  return body.access_token ? { token: body.access_token } : { error: body.error_description ?? "GitHub didn't return a token." };
}

/** Step 4: the client proves it started the flow (PKCE) and gets its access token. */
export async function token(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  const p = type.includes("application/json") ? new URLSearchParams(Object.entries(JSON.parse(raw || "{}") as Record<string, string>)) : new URLSearchParams(raw);
  if (p.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "Only authorization_code is supported; tokens don't expire.");
  const code = await unseal<{ t: string; c?: string; challenge: string; redirectUri: string }>("code", p.get("code") ?? "");
  if (!code) return oauthError("invalid_grant", "The code is invalid or expired.");
  if (p.get("redirect_uri") && p.get("redirect_uri") !== code.redirectUri) return oauthError("invalid_grant", "redirect_uri doesn't match.");
  const verifier = p.get("code_verifier") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  if (!verifier || Buffer.from(digest).toString("base64url") !== code.challenge) return oauthError("invalid_grant", "PKCE check failed.");
  return json({ access_token: TOKEN_PREFIX + (await seal("token", { t: code.t, c: code.c })), token_type: "Bearer" });
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
