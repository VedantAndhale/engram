# Engram server

Two jobs, one Vercel function: **Sign in with GitHub** for the Engram app, and an MCP server that
lets any MCP client (Claude, ChatGPT, Cursor, VS Code…) search your Engram library (read-only for now).

It stores nothing. It reads your folder repositories through the GitHub API with your own sign-in,
and answers from each folder's `index.json`, which the app writes when it syncs.

| Tool | What it does |
| --- | --- |
| `search` | Titles, topics, your notes and highlights, across every folder |
| `read_item` | One item in full; text saved from the source comes back fenced and marked untrusted |
| `list_recent` | Newest saved or edited items |
| `get_highlights` | One item's highlights, or the latest across your library |
| `quiz_me` | Highlights due for review, for your agent to test you on |

## Set up (once)

1. Create a GitHub OAuth App: GitHub → Settings → Developer settings → OAuth Apps → New.
   - Homepage URL: `https://engram.vedant.me`
   - Authorization callback URL: `https://engram.vedant.me/api/oauth/callback`
   The app and MCP clients share this one OAuth App.
2. In the Vercel project, add these environment variables, then redeploy:
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: from the OAuth App
   - `MCP_SECRET`: at least 32 random characters (`openssl rand -base64 48`). Changing it signs
     every client out.
3. Open Engram once on any device so each folder writes its `index.json`.

## Connect a client

Add `https://engram.vedant.me/api/mcp` as a remote MCP server. The client opens a page where you
approve it, then GitHub sign-in.

## Run it locally

```bash
npm run mcp
```

Run it next to `npm run dev`, which proxies `/api` and `/.well-known` to it, so everything shares
`http://localhost:5173`: the app's sign-in, and MCP clients at `http://localhost:5173/api/mcp`. Put
the three variables in `.env.local`, using a second OAuth App whose callback is
`http://localhost:5173/api/oauth/callback`.
