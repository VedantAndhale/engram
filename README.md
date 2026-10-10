# Engram

A second brain that lives in your own GitHub account.

**Try it:** [engram.vedant.me](https://engram.vedant.me/)

Engram is a local-first web app for reading and keeping what matters: PDFs, articles, posts,
tweets, links, quotes and your own notes. Each one is a Markdown file, with your highlights and your
own words about it. Every folder syncs to its own private GitHub repository, so your library is on
every device and nothing sits on someone else's server.

Where it is heading: a Markdown editor, and an open door for any AI agent that needs your memory.

## Features

- **Save anything in a second.** Press `N` (or paste anywhere) to save a link, a quote or a note.
  The **Save to Engram** bookmark keeps any page's text and your selection, in every desktop browser.
  On Android, share to the installed app.
- **PDF reading** with a fast, crisp renderer (pdf.js), zoom, and your place remembered per document.
- **Highlights, notes and ink.** Select text to highlight it, attach a note, or draw with a pen.
  Export a document's notes as Markdown.
- **Search** across every page, highlight, note and saved page, in all your folders.
- **Folders that sync through GitHub.** Each folder is a private repository you own. Share a folder by
  adding collaborators on GitHub.
- **Works offline.** Installable as a PWA, data kept in IndexedDB.
- **Light, sepia and dark themes**, and a layout that works from phones to wide desktops.

## Run it

Needs Node 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Open http://localhost:5173. To sync, choose **Connect GitHub** in the sidebar, then **Sign in with
GitHub**. Sign-in needs the server running too (`npm run mcp`) and a GitHub OAuth App: see
[mcp/README.md](mcp/README.md).

```bash
npm run build
```

The build in `dist/` is a static site with relative paths and hash routing. Sign-in and MCP need the
function in `api/`, so deploy on Vercel at a domain root.

### Deploy on Vercel

Import the repository in Vercel. It detects Vite: build command `npm run build`, output directory
`dist`, and serves `api/mcp.ts` as a function. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
`MCP_SECRET` (see [mcp/README.md](mcp/README.md)). After sign-in, the app talks to GitHub straight
from the browser; the server only swaps GitHub's sign-in code for a token and stores nothing.

## How your data is stored

| Where | What |
| --- | --- |
| Your browser (IndexedDB) | Documents, annotations, search index, reading positions |
| Your GitHub repo, one per folder | `library.json`, `pdfs/<sha256>.pdf`, `annotations/<sha256>.json`, `positions/<user>.json` |

Your GitHub sign-in stays in your browser and is sent only to `api.github.com`.

## Tech

React 19, TypeScript, Vite, pdf.js, Dexie (IndexedDB), MiniSearch, Zustand, perfect-freehand.

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Engram freely. If you run a modified version
as a service for others, you must publish your changes under the same license.
