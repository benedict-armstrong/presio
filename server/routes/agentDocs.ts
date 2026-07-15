import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type express from "express";
import { baseUrl } from "../lib/baseUrl.js";
import { buildOpenApi } from "../agent/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(__dirname, "../agent/content");

const CACHE = "public, max-age=300";

function readContent(name: string): string {
  return fs.readFileSync(path.join(CONTENT, name), "utf8");
}

function withBase(text: string, base: string): string {
  return text.replaceAll("BASE", base);
}

function sendText(res: express.Response, type: string, body: string) {
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Cache-Control", CACHE);
  res.send(body);
}

function prefersMarkdown(req: express.Request): boolean {
  const accept = req.get("accept") || "";
  if (!accept.includes("text/markdown")) return false;
  // Browsers navigating for HTML send text/html first; don't override those.
  const htmlIdx = accept.indexOf("text/html");
  const mdIdx = accept.indexOf("text/markdown");
  if (htmlIdx === -1) return true;
  return mdIdx !== -1 && mdIdx < htmlIdx;
}

const SITEMAP_PATHS = [
  "/",
  "/about",
  "/check",
  "/index.md",
  "/about.md",
  "/check.md",
  "/llms.txt",
  "/llms-full.txt",
  "/AGENTS.md",
  "/api.md",
  "/openapi.json",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemap.md",
  "/.well-known/mcp.json",
];

export function registerAgentDocRoutes(app: express.Express) {
  app.get("/llms.txt", (req, res) => {
    sendText(res, "text/plain", withBase(readContent("llms.txt"), baseUrl(req)));
  });

  app.get("/llms-full.txt", (req, res) => {
    sendText(res, "text/plain", withBase(readContent("llms-full.txt"), baseUrl(req)));
  });

  app.get("/AGENTS.md", (req, res) => {
    sendText(res, "text/markdown", withBase(readContent("AGENTS.md"), baseUrl(req)));
  });

  app.get("/api.md", (req, res) => {
    sendText(res, "text/markdown", withBase(readContent("api.md"), baseUrl(req)));
  });

  app.get("/index.md", (req, res) => {
    sendText(res, "text/markdown", withBase(readContent("index.md"), baseUrl(req)));
  });

  app.get("/about.md", (req, res) => {
    sendText(res, "text/markdown", withBase(readContent("about.md"), baseUrl(req)));
  });

  app.get("/check.md", (req, res) => {
    sendText(res, "text/markdown", withBase(readContent("check.md"), baseUrl(req)));
  });

  app.get("/openapi.json", (req, res) => {
    res.setHeader("Cache-Control", CACHE);
    res.json(buildOpenApi(baseUrl(req)));
  });

  app.get("/robots.txt", (req, res) => {
    const base = baseUrl(req);
    const body = [
      "# AI agents: see /llms.txt for how to use Presio",
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${base}/sitemap.xml`,
      "",
    ].join("\n");
    sendText(res, "text/plain", body);
  });

  app.get("/sitemap.xml", (req, res) => {
    const base = baseUrl(req);
    const urls = SITEMAP_PATHS.map(
      (p) => `  <url>\n    <loc>${base}${p === "/" ? "/" : p}</loc>\n  </url>`
    ).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", CACHE);
    res.send(xml);
  });

  app.get("/sitemap.md", (req, res) => {
    const base = baseUrl(req);
    const lines = ["# Sitemap", "", ...SITEMAP_PATHS.map((p) => `- ${base}${p === "/" ? "/" : p}`), ""];
    sendText(res, "text/markdown", lines.join("\n"));
  });

  // Content negotiation: Prefer markdown mirrors when Accept says so.
  for (const [route, file] of [
    ["/", "index.md"],
    ["/about", "about.md"],
    ["/check", "check.md"],
  ] as const) {
    app.get(route, (req, res, next) => {
      if (!prefersMarkdown(req)) return next();
      sendText(res, "text/markdown", withBase(readContent(file), baseUrl(req)));
    });
  }
}
