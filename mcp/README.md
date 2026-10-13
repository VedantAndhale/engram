# Engram server

Two jobs, one Vercel function: **Sign in with GitHub** for the Engram app, and an MCP server that
lets any MCP client (Claude, ChatGPT, Cursor, VS Code…) search your Engram library and send things to its inbox.

It stores nothing. It reads your folder repositories through the GitHub API with your own sign-in,
and answers from each folder's `index.json`, which the app writes when it syncs. Its only write is
a new file in a folder's `inbox/`, which waits there until you accept or dismiss it in the app.

| Tool | What it does |
| --- | --- |
| `search` | Titles, topics, your notes and highlights, across every folder; takes extra phrasings in `also` |
| `read_item` | One item in full; text saved from the source comes back fenced and marked untrusted |
| `list_recent` | Newest saved or edited items |
| `get_highlights` | One item's highlights, or the latest across your library |
| `quiz_me` | Highlights due for review, for your agent to test you on |
| `save_item` | Sends a link or some text to your inbox, with why it's worth keeping |
| `append_note` | Suggests lines for your notes on one item, waiting in your inbox |

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

## Sign-up list (optional)

When someone signs in to the app, the server reads their primary verified GitHub email and records
it with their login, name and sign-up date in an Airtable table you own. Signing in again updates
the row. Without these variables nothing is recorded.

1. Create an Airtable base with a table named `Signups` (or set `AIRTABLE_TABLE`). Add these fields:
   `login` (single line text), `email` (email), `name` (single line text), `signed_up` (single line
   text).
2. Create a personal access token at airtable.com/create/tokens with `data.records:read` and
   `data.records:write`, limited to that base.
3. In Vercel, add `AIRTABLE_TOKEN` (the token) and `AIRTABLE_BASE_ID` (the base ID, starting `app`),
   then redeploy.

Airtable's free plan allows 1,000 records per base. Past that, sign-in still works and the server
logs that a sign-up wasn't recorded, without the address.

## Connect a client

Add `https://engram.vedant.me/api/mcp` as a remote MCP server. The client opens a page where you
approve it, then GitHub sign-in. Access lasts 30 days, then the client asks you to approve it again.
A client can end its own access early at `/api/oauth/revoke` (RFC 7009); the app's Disconnect uses
the same route for its own sign-in.

## Run it locally

```bash
npm run mcp
```

Run it next to `npm run dev`, which proxies `/api` and `/.well-known` to it, so everything shares
`http://localhost:5173`: the app's sign-in, and MCP clients at `http://localhost:5173/api/mcp`. Put
the three variables in `.env.local`, using a second OAuth App whose callback is
`http://localhost:5173/api/oauth/callback`.
