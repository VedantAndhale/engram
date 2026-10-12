# Engram

A second brain that lives in your own GitHub account.

**Try it:** [engram.vedant.me](https://engram.vedant.me/)

Engram is a web app for reading and keeping what matters: PDFs, articles, posts, links, quotes and
your own notes. Everything you keep is a Markdown file, with your highlights and your own words about
it. Each folder syncs to a private GitHub repository in your account, so your library is on every
device, and it stays readable as plain Markdown without Engram.

Engram is also a memory for AI agents. Connect one through MCP and it can search your library, read
what you saved and suggest additions, which you accept or dismiss.

## Features

**Save**

- Press `N`, or paste anywhere, to save a link, a quote or a note.
- The **Save to Engram** bookmark keeps a page's formatted text and your selection. Allow pop-ups for
  the page when you use it. Some sites with strict security settings block bookmarks; paste the link
  instead.
- On Android, share to Engram from the share sheet. On iPhone, copy the link, open Engram and paste it
  under Save.
- A link saved without its text is fetched once through Engram's server, which keeps nothing. Only the
  page's address is sent.

**Read**

- Articles open in a reading view. Turn on the highlighter to mark text, use A− and A+ to change the
  size, and tap a highlight to change its colour, add a note or delete it.
- PDFs use pdf.js, with zoom, and your place is remembered per document. Keys: `V` select, `H`
  highlight, `D` pen, `E` eraser, `N` notes, `/` find.
- On a phone or tablet, pick the highlighter or pen. One finger marks, two fingers scroll.
- Export a PDF's highlights and notes as a Markdown file.

**Write**

- Notes are Markdown with a live preview. Type `/` for blocks, `[[Title]]` to link an item,
  `[[Title#^ref]]` or `![[Title#^ref]]` to link or embed a highlight, and `$…$` or `$$…$$` for math.
- Each item shows what links to it.
- Drag a block to move it, and fold headings and lists.

**Review**

- Today brings your highlights back on a spacing schedule: after 1, 3, 7, 16, 35 and 90 days.
  "Still clear" spaces them further; "Hazy" brings one back tomorrow.
- Today also has a page for today's note, and an optional daily reminder that adds a repeating
  calendar event (an `.ics` file, or Google Calendar).
- Pick the topics you are growing in, and Today shows your progress in each.

**Find**

- Search covers pages, highlights, notes and saved text, in every folder.
- `Ctrl+K` goes to anything. Press `?` for every keyboard shortcut.

**Connect an AI agent**

- Engram has a hosted MCP server. An agent can search your library, read items and highlights, and
  quiz you on highlights due for review.
- Agents can also suggest a link or some text to save, or lines for an item's notes. Suggestions wait
  under **From your agents** on Today until you accept or dismiss them.
- Saved web text comes back marked as untrusted, so a page you saved cannot instruct your agent.
- Setup and the tool list: [mcp/README.md](mcp/README.md).

**Folders and sync**

- Each folder is a private GitHub repository. Keep as many folders as you like.
- Works offline. Install Engram as an app (PWA), and your data is kept in IndexedDB. A PDF that the
  browser has cleared from its cache needs a connection to open again.
- Light, sepia and dark themes, and a layout that works from phones to wide desktops.

## Your data

| Where | What |
| --- | --- |
| Your browser (IndexedDB) | Items, PDFs, highlights and notes, reading positions, uploads waiting to sync, agent suggestions, the search text |
| Your GitHub account, one private repository per folder | Items as Markdown, PDFs, highlights, reading positions, the folder's search index, and agent suggestions waiting in `inbox/` |
| Engram's server | Nothing of yours is kept. It exchanges GitHub's sign-in code for a token, answers MCP requests using your own GitHub access, fetches pages for links you save, writes agent suggestions into your repository's `inbox/`, and, on sign-in, records your primary GitHub email, login and name in the Airtable table its owner configures |

**Page views.** The hosted site counts page views with [GoatCounter](https://www.goatcounter.com/). It
counts the screen you open (today, library, item, search), never folder or item IDs. Self-hosted
copies count nothing unless you set `VITE_GOATCOUNTER` to your own GoatCounter code.

**Signing in.** Engram asks GitHub for `repo` access, which covers every private repository your GitHub
account has, not only Engram's folders. It also asks for your email address, which the hosted site
keeps in a sign-up list its owner can see (see the server setup in [mcp/README.md](mcp/README.md)). Your token is kept in this browser and sent only to
`api.github.com`. To disconnect, use **Disconnect** in Engram, then revoke it under GitHub → Settings →
Applications.

**Limits to plan around.** GitHub repositories should stay under about 5 GB, with a 100 MB limit per
file and a rate limit on API requests, so large PDF or video libraries need care. The iPhone has no
share sheet for Engram yet.

## Run it yourself

Needs Node 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Open http://localhost:5173. Reading, saving and search work without an account. To sync, or to connect
an agent, you also need the server and a GitHub OAuth App. See [mcp/README.md](mcp/README.md).

```bash
npm run build
```

The build in `dist/` is a static site with relative paths and hash routing. Sign-in and MCP need the
function in `api/`, so deploy on Vercel at a domain root.

### Deploy on Vercel

Import the repository in Vercel. It detects Vite: build command `npm run build`, output directory
`dist`, and it serves `api/mcp.ts` as a function. Set these environment variables, then redeploy:

- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, from your GitHub OAuth App
- `MCP_SECRET`, at least 32 random characters. Changing it signs every client out.
- `PUBLIC_URL` (optional), if the function should use a public address instead of the one a request
  arrived on

Full steps, including the OAuth App's callback URL, are in [mcp/README.md](mcp/README.md).

If you host Engram yourself, your host keeps its own request logs.

## Tech

React 19, TypeScript, Vite, pdf.js, Dexie (IndexedDB), MiniSearch, Zustand, CodeMirror 6, KaTeX,
Mozilla Readability, perfect-freehand and the MCP TypeScript SDK.

## Status and roadmap

Engram is early software. [ROADMAP.md](ROADMAP.md) lists what is planned and what Engram deliberately
will not do.

## Contributing

Bug reports and ideas are welcome as GitHub issues. Please describe the steps you took and the device
and browser you used, and leave out any private highlights, notes or repository links.

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Engram freely. If you run a modified version
as a service for others, you must publish your changes under the same license.
