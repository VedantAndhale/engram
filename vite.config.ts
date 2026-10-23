import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { VitePWA } from "vite-plugin-pwa";
import { copyFileSync, readFileSync } from "node:fs";

// The hosted site's security headers (vercel.json), also sent by `vite preview` so the build can be checked under them.
// Not by the dev server: its hot reload runs inline scripts the policy forbids.
const siteHeaders: Record<string, string> = Object.fromEntries(
  (JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as { headers: { headers: { key: string; value: string }[] }[] }).headers[0].headers.map((h) => [h.key, h.value]),
);

// The app's address on its host. "/" serves the hosted site from a domain root, so clean paths (/today) work.
// For a subfolder such as GitHub Pages (/<repo>/), build with BASE_PATH=/<repo>/.
const base = process.env.BASE_PATH || "/";

// GitHub Pages answers unknown paths with 404.html. A copy of the app shell there lets a clean path such as
// /<repo>/today load the app on a host without rewrites. The app reads the path itself, so nothing else changes.
const spaFallback = {
  name: "spa-fallback",
  apply: "build" as const,
  closeBundle() {
    copyFileSync(new URL("./dist/index.html", import.meta.url), new URL("./dist/404.html", import.meta.url));
  },
};

export default defineConfig({
  base,
  plugins: [
    react(),
    spaFallback,
    viteStaticCopy({
      targets: [
        ...["cmaps", "standard_fonts", "wasm", "iccs"].map((dir) => ({
          src: `node_modules/pdfjs-dist/${dir}/*`,
          dest: `pdfjs/${dir}`,
        })),
        // The LiteRT-LM runtime for Gemma (src/ai). Served from the app's own origin, never a CDN.
        { src: "node_modules/@litert-lm/core/wasm/*", dest: "litert", rename: { stripBase: 4 } },
      ],
    }),
    VitePWA({
      // A new version waits until you choose to reload (see main.tsx), so an update never drops a
      // share or a half-typed save.
      registerType: "prompt",
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // /api and /.well-known belong to the MCP server; its sign-in pages are navigations too.
        navigateFallbackDenylist: [/^\/pdfjs\//, /^\/api\//, /^\/\.well-known\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/pdfjs/"),
            handler: "CacheFirst",
            options: { cacheName: "pdfjs-assets" },
          },
        ],
      },
      manifest: {
        name: "Engram",
        short_name: "Engram",
        description: "A reader that keeps your library in your own GitHub account, and reads with you on your device.",
        theme_color: "#f6f1e7",
        background_color: "#f6f1e7",
        display: "standalone",
        // PNGs made from icon.svg by scripts/icons.mjs; the maskable one has room for the launcher's crop.
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // "Share → Engram" on Android. The installed app opens from its own cache, and the
        // shared text is read and dropped from the address at once (see App.tsx).
        share_target: {
          action: base,
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
      },
    }),
  ],
  build: { target: "es2022" },
  // The LiteRT-LM runtime loads its WASM with importScripts, which only a classic worker has.
  worker: { format: "iife" },
  // Sign-in lives in the server (npm run mcp); in production it shares the app's domain.
  server: { proxy: { "/api": "http://localhost:8787", "/.well-known": "http://localhost:8787" } },
  preview: { headers: siteHeaders },
});
