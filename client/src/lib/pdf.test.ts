// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { freshPdfUrl } from "@/lib/pdf";

// A replace rewrites a synced deck's stored object in place, so the URL is the
// same before and after. Every load that must not serve the previous deck goes
// through freshPdfUrl.
describe("freshPdfUrl", () => {
  it("adds the version as the first query parameter", () => {
    expect(freshPdfUrl("https://storage.test/ABC123.pdf", 1234)).toBe(
      "https://storage.test/ABC123.pdf?v=1234"
    );
  });

  it("appends to a URL that already carries a query string", () => {
    expect(freshPdfUrl("https://storage.test/ABC123.pdf?token=xyz", 1234)).toBe(
      "https://storage.test/ABC123.pdf?token=xyz&v=1234"
    );
  });

  it("is stable for the same version, so a page reload reuses the fetch", () => {
    const url = "https://storage.test/ABC123.pdf";
    expect(freshPdfUrl(url, 99)).toBe(freshPdfUrl(url, 99));
  });

  it("differs once the version does, so new bytes are actually fetched", () => {
    const url = "https://storage.test/ABC123.pdf";
    expect(freshPdfUrl(url, 1)).not.toBe(freshPdfUrl(url, 2));
  });
});
