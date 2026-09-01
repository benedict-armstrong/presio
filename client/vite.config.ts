/// <reference types="vitest/config" />
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Bake the built asset list into the shipped service worker so a fresh install
// precaches the whole app up front. The pdf.js worker and its wasm helper are
// separate chunks that aren't fetched until the first PDF renders, so caching
// on demand leaves an installed-then-offline app unable to open a deck.
function precacheServiceWorker(): Plugin {
  let outDir = ""
  return {
    name: "presio-sw-precache",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const swPath = path.join(outDir, "sw.js")
      if (!fs.existsSync(swPath)) return

      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name)
          return entry.isDirectory() ? walk(full) : [full]
        })

      // "/" stands in for index.html, which is what a navigation asks for and
      // what the fetch handler falls back to.
      const assets = walk(outDir)
        .map((file) => "/" + path.relative(outDir, file).split(path.sep).join("/"))
        .filter((url) => url !== "/sw.js" && url !== "/index.html")
        .sort()
      const manifest = ["/", ...assets]

      // Content-derived so a deploy that changes nothing keeps its cache, and
      // any real change makes a new one that `activate` sweeps the old into.
      const buildId = crypto
        .createHash("sha256")
        .update(manifest.join("\n"))
        .update(fs.readFileSync(path.join(outDir, "index.html")))
        .digest("hex")
        .slice(0, 12)

      const sw = fs
        .readFileSync(swPath, "utf8")
        .replace('"__BUILD_ID__"', JSON.stringify(buildId))
        .replace('"__PRECACHE_MANIFEST__"', JSON.stringify(manifest))
      fs.writeFileSync(swPath, sw)
    },
  }
}

export default defineConfig({
  plugins: [react(), precacheServiceWorker()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/mcp": "http://localhost:3001",
      "/.well-known": "http://localhost:3001",
      "/llms.txt": "http://localhost:3001",
      "/llms-full.txt": "http://localhost:3001",
      "/robots.txt": "http://localhost:3001",
      "/sitemap.xml": "http://localhost:3001",
      "/sitemap.md": "http://localhost:3001",
      "/AGENTS.md": "http://localhost:3001",
      "/api.md": "http://localhost:3001",
      "/openapi.json": "http://localhost:3001",
      "/index.md": "http://localhost:3001",
      "/check.md": "http://localhost:3001",
      "/schema": "http://localhost:3001",
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
  test: {
    // Default to a node environment; DOM-dependent tests opt in per-file with
    // a `// @vitest-environment happy-dom` comment.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
