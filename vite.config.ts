import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { VitePWA } from "vite-plugin-pwa";

// Relative base so the build works on GitHub Pages under /<repo>/ as well as at a domain root.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    viteStaticCopy({
      targets: ["cmaps", "standard_fonts", "wasm", "iccs"].map((dir) => ({
        src: `node_modules/pdfjs-dist/${dir}/*`,
        dest: `pdfjs/${dir}`,
      })),
    }),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/pdfjs\//],
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
        description: "Your second brain: read, highlight and keep notes, synced through GitHub.",
        theme_color: "#f6f1e7",
        background_color: "#f6f1e7",
        display: "standalone",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
    }),
  ],
  build: { target: "es2022" },
});
