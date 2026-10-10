import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { handle } from "./handler.js";

/*
 * The server on your machine: npm run mcp. The app's dev server (npm run dev) proxies /api and
 * /.well-known here, so sign-in and MCP (http://localhost:5173/api/mcp) share the app's address.
 * Reads GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and MCP_SECRET from .env.local if it exists.
 */

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  // The Host header, not our port: the app's dev server proxies /api here, and sign-in must return there.
  const out = await handle(new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url}`, { method: req.method, headers, body }));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log(`Engram MCP on http://localhost:${port}/api/mcp`));
