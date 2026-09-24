// Built-in plugins written in TypeScript (+ React). Each client/plugins/<name>/
// holds a presio-plugin.json and a main.tsx or main.ts; this bundles it (and
// the CSS it imports) into the one self-contained HTML file the plugin frame
// requires, served at /plugins/<name>/ beside its manifest — built on request
// by the dev server, emitted into dist by `vite build`. Plain plugins that
// need no build still live in public/plugins/.

import fs from "fs"
import path from "path"
import { build, type Plugin } from "vite"
import react from "@vitejs/plugin-react"

const ROOT = import.meta.dirname
const URL_RE = /^\/plugins\/([a-z0-9-]+)\/(index\.html|presio-plugin\.json)$/

function pluginNames(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, "presio-plugin.json")))
    .map((d) => d.name)
}

function entry(name: string): string {
  const tsx = path.join(ROOT, name, "main.tsx")
  return fs.existsSync(tsx) ? tsx : path.join(ROOT, name, "main.ts")
}

/**
 * Whether viewers run it. The presenter publishes those over the session's
 * socket, which caps a bundle's size (MAX_PLUGIN_HTML_BYTES on the server), so
 * they're minified in dev too.
 */
function publishes(name: string): boolean {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, name, "presio-plugin.json"), "utf8"))
  const surfaces: unknown[] = Array.isArray(manifest.surfaces) ? manifest.surfaces : []
  return surfaces.includes("viewer") || surfaces.includes("slide")
}

/** One plugin as a single HTML document: its script and styles inlined. */
async function bundle(name: string, dev: boolean): Promise<string> {
  const result = await build({
    configFile: false,
    envDir: false,
    root: path.join(ROOT, name),
    logLevel: "warn",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    build: {
      write: false,
      minify: !dev || publishes(name),
      lib: { entry: entry(name), formats: ["iife"], name: "presioPlugin" },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []))
  let js = ""
  let css = ""
  for (const out of outputs) {
    if (out.type === "chunk") js += out.code
    else if (out.fileName.endsWith(".css")) css += String(out.source)
  }
  // Inline, so nothing in them may close the tag they sit in.
  const safe = (text: string, tag: string) => text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${safe(css, "style")}</style>
</head>
<body>
<div id="root"></div>
<script>${safe(js, "script")}</script>
</body>
</html>
`
}

export function builtinPlugins(): Plugin {
  return {
    name: "presio-builtin-plugins",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = URL_RE.exec((req.url ?? "").split("?")[0])
        if (!match || !pluginNames().includes(match[1])) return next()
        const [, name, file] = match
        const body =
          file === "index.html"
            ? bundle(name, true)
            : fs.promises.readFile(path.join(ROOT, name, "presio-plugin.json"), "utf8")
        body.then(
          (text) => {
            res.setHeader("Content-Type", file === "index.html" ? "text/html" : "application/json")
            res.setHeader("Cache-Control", "no-cache")
            res.end(text)
          },
          (err) => next(err)
        )
      })
    },
    async generateBundle() {
      for (const name of pluginNames()) {
        this.emitFile({ type: "asset", fileName: `plugins/${name}/index.html`, source: await bundle(name, false) })
        this.emitFile({
          type: "asset",
          fileName: `plugins/${name}/presio-plugin.json`,
          source: fs.readFileSync(path.join(ROOT, name, "presio-plugin.json"), "utf8"),
        })
      }
    },
  }
}
