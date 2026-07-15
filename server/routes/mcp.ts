import type express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { baseUrl } from "../lib/baseUrl.js";
import { createPresentHandoff } from "../lib/presentHandoff.js";
import { buildCheckReport } from "./check.js";
import { resolveOptionalUserId } from "../auth.js";

function createPresioMcp(supabase: SupabaseClient, origin: string, req: express.Request) {
  const server = new McpServer({
    name: "presio",
    version: "1.0.0",
  });

  server.registerTool(
    "present_pdf",
    {
      title: "Present a PDF",
      description:
        "Upload a PDF to start a local Presio presentation. Returns a url — open it in a browser to finish handoff (skips share). Same as POST /api/present.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        pdf_base64: z.string().describe("PDF file contents, base64-encoded"),
        filename: z.string().optional().describe("Original filename, e.g. deck.pdf"),
      },
    },
    async ({ pdf_base64, filename }) => {
      const buffer = Buffer.from(pdf_base64, "base64");
      const userId = await resolveOptionalUserId(supabase, req);
      const result = await createPresentHandoff(supabase, {
        buffer,
        originalName: filename || "presentation.pdf",
        userId,
        baseUrl: origin,
      });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      const payload = {
        id: result.id,
        url: result.url,
        filename: result.filename,
        totalSlides: result.totalSlides,
        next: result.next,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    }
  );

  server.registerTool(
    "check_pdf",
    {
      title: "Check PDF sidecars",
      description:
        "Validate Presio notes/media sidecar attachments in a PDF. Same as POST /api/check.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        pdf_base64: z.string().describe("PDF file contents, base64-encoded"),
      },
    },
    async ({ pdf_base64 }) => {
      const buffer = Buffer.from(pdf_base64, "base64");
      const result = await buildCheckReport(buffer, origin);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result.report, null, 2) }] };
    }
  );

  return server;
}

export function registerMcpRoutes(app: express.Express, supabase: SupabaseClient) {
  app.get("/.well-known/mcp.json", (req, res) => {
    const origin = baseUrl(req);
    res.setHeader("Cache-Control", "public, max-age=300");
    // Public discovery metadata — readable from any origin, unlike the API.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      // Top-level name/description/version/endpoint duplicated for scanners
      // that expect a flat server card rather than the nested shape.
      name: "presio",
      version: "1.0.0",
      description: "Start local PDF presentations and validate Presio sidecars",
      endpoint: `${origin}/mcp`,
      protocolVersion: "2025-11-25",
      serverInfo: {
        name: "presio",
        version: "1.0.0",
        description: "Start local PDF presentations and validate Presio sidecars",
      },
      transport: { type: "streamable-http", endpoint: `${origin}/mcp` },
      capabilities: { tools: true },
      authentication: { required: false },
    });
  });

  app.post("/mcp", async (req, res) => {
    const origin = baseUrl(req);
    const server = createPresioMcp(supabase, origin, req);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for streamable HTTP." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });
}
