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
