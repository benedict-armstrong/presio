/// <reference types="vitest/config" />
import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
      "/about.md": "http://localhost:3001",
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
