/** Host-aware OpenAPI 3.1 document for agent-facing endpoints. */
export function buildOpenApi(base: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Presio",
      version: "1.0.0",
      description:
        "Upload a PDF to start a local presentation, or validate Presio sidecar attachments. See /llms.txt and /api.md.",
    },
    servers: [{ url: base }],
    paths: {
      "/api/present": {
        post: {
          summary: "Start a local presentation from a PDF",
          description:
            "Stages the PDF and returns a url. Opening the url copies the PDF into the browser (local session), deletes the server copy, and skips the share screen.",
          operationId: "present",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: { type: "string", format: "binary", description: "PDF file" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Handoff URL",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "url", "filename", "totalSlides", "next"],
                    properties: {
                      id: { type: "string" },
                      url: { type: "string", format: "uri" },
                      filename: { type: "string" },
                      totalSlides: { type: "integer" },
                      next: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/check": {
        post: {
          summary: "Validate PDF sidecar attachments",
          operationId: "check",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Check report",
              content: {
                "application/json": {
                  schema: { $ref: `${base}/schema/check-report.schema.json` },
                },
              },
            },
          },
        },
      },
      "/api/sessions/{id}/handoff": {
        get: {
          summary: "Download staged handoff PDF",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "t", in: "query", required: true, schema: { type: "string" }, description: "Controller token" },
          ],
          responses: {
            "200": {
              description: "PDF bytes",
              content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
            },
          },
        },
      },
      "/api/sessions/{id}/handoff/complete": {
        post: {
          summary: "Clear staged PDF after browser handoff",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "x-controller-token",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
    },
  };
}
