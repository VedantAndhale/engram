import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorizationServer, authorize, callback, caller, login, origin, protectedResource, refresh, register, revoke, token } from "./oauth.js";
import { page } from "./page.js";
import { createServer } from "./server.js";

/*
 * Every request Engram's server answers, as one fetch-style handler: the MCP endpoint, the
 * OAuth discovery documents, the sign-in steps (for the app and for MCP clients) and fetching
 * pages for the app to read. Runs as
 * one Vercel function (see vercel.json for the routes) and under mcp/dev.ts locally.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

/** Which endpoint: Vercel passes it as ?route= (see vercel.json); locally it's the path. */
function routeOf(url: URL): string {
  const r = url.searchParams.get("route");
  if (r) return r;
  const p = url.pathname.replace(/\/+$/, "");
  if (p.startsWith("/.well-known/oauth-protected-resource")) return "protected-resource";
  if (p.startsWith("/.well-known/oauth-authorization-server")) return "authorization-server";
  if (p === "/api/page") return "page";
  const m = /^\/api\/oauth\/(\w+)$/.exec(p);
  return m ? m[1] : "mcp";
}

async function route(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  switch (routeOf(new URL(req.url))) {
    case "protected-resource":
      return protectedResource(req);
    case "authorization-server":
      return authorizationServer(req);
    case "register":
      return req.method === "POST" ? register(req) : new Response(null, { status: 405 });
    case "authorize":
      return authorize(req);
    case "login":
      return login(req);
    case "callback":
      return callback(req);
    case "token":
      return req.method === "POST" ? token(req) : new Response(null, { status: 405 });
    case "refresh":
      return req.method === "POST" ? refresh(req) : new Response(null, { status: 405 });
    case "revoke":
      return req.method === "POST" ? revoke(req) : new Response(null, { status: 405 });
    case "page":
      return page(req);
    case "mcp":
      return mcp(req);
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function mcp(req: Request): Promise<Response> {
  const who = await caller(req);
  if (!who) {
    // No token, or one that expired (30 days) or was revoked: the header sends the client back to sign in.
    const presented = req.headers.has("authorization");
    return new Response(JSON.stringify({ error: "invalid_token", error_description: "Sign in with GitHub to use Engram." }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource"${presented ? ', error="invalid_token"' : ""}`,
      },
    });
  }
  // Stateless: no sessions, so any instance can answer any request.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createServer(who.token, origin(req), who.agent);
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function handle(req: Request): Promise<Response> {
  let res: Response;
  try {
    res = await route(req);
  } catch (e) {
    // The details go to the log only: an exception's message can carry internals.
    console.error(e);
    res = new Response(JSON.stringify({ error: "server_error", error_description: "Something went wrong on Engram's server. Try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
