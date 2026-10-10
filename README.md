# Engram

A second brain that lives in your own GitHub account.

**Try it:** [engram.vedant.me](https://engram.vedant.me/)

Engram is a local-first web app for reading and keeping what matters. Today it is a calm PDF reader:
highlight, write notes and draw on any PDF, then find it all again with full-text search. Every
folder syncs to its own private GitHub repository, so your library is on every device and nothing
sits on someone else's server.

Where it is heading: one place for everything you read and save (articles, posts, tweets, links,
PDFs, notes), written in Markdown, and open to any AI agent that needs your memory.

## Features

- **PDF reading** with a fast, crisp renderer (pdf.js), zoom, and your place remembered per document.
- **Highlights, notes and ink.** Select text to highlight it, attach a note, or draw with a pen.
  Export a document's notes as Markdown.
- **Search** across every page, highlight and note, in all your folders.
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

Open http://localhost:5173. To sync, choose **Connect GitHub** in the sidebar and paste a
personal access token. The app explains which kind of token to create and why.

```bash
npm run build
```

The build in `dist/` is a static site. It uses relative paths and hash routing, so it runs at a
domain root, on a subpath, or on any static host.

### Deploy on Vercel

Import the repository in Vercel. It detects Vite: build command `npm run build`, output directory
`dist`. No environment variables are needed, because the app talks to GitHub straight from the
browser with the token you give it.

## How your data is stored

| Where | What |
| --- | --- |
| Your browser (IndexedDB) | Documents, annotations, search index, reading positions |
| Your GitHub repo, one per folder | `library.json`, `pdfs/<sha256>.pdf`, `annotations/<sha256>.json`, `positions/<user>.json` |

Your token stays in your browser and is sent only to `api.github.com`.

## Tech

React 19, TypeScript, Vite, pdf.js, Dexie (IndexedDB), MiniSearch, Zustand, perfect-freehand.

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Engram freely. If you run a modified version
as a service for others, you must publish your changes under the same license.
