import { describe, it, expect } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { safeLinkUrl, linkRectPct, resolveDestSlide } from "./pdfLinks";

describe("safeLinkUrl", () => {
  it("keeps web and mail links", () => {
    expect(safeLinkUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeLinkUrl("http://example.com")).toBe("http://example.com");
    expect(safeLinkUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("drops scripting and other schemes", () => {
    expect(safeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(safeLinkUrl("data:text/html,<script>")).toBeNull();
    expect(safeLinkUrl("file:///etc/passwd")).toBeNull();
  });

  it("drops presio's own note: annotations, which are not links", () => {
    expect(safeLinkUrl("note:Remember%20to%20breathe")).toBeNull();
  });

  it("drops anything that isn't a usable string", () => {
    expect(safeLinkUrl(undefined)).toBeNull();
    expect(safeLinkUrl("")).toBeNull();
    expect(safeLinkUrl("not a url")).toBeNull();
    expect(safeLinkUrl(42)).toBeNull();
  });
});

describe("linkRectPct", () => {
  it("converts a viewport rectangle to page fractions", () => {
    expect(linkRectPct([100, 50, 300, 150], 1000, 500)).toEqual({
      xPct: 0.1,
      yPct: 0.1,
      wPct: 0.2,
      hPct: 0.2,
    });
  });

  it("accepts corners given in either order", () => {
    // pdf.js does not guarantee which corner comes first.
    expect(linkRectPct([300, 150, 100, 50], 1000, 500)).toEqual(
      linkRectPct([100, 50, 300, 150], 1000, 500)
    );
  });

  it("rejects degenerate boxes and unmeasured viewports", () => {
    expect(linkRectPct([100, 50, 100, 150], 1000, 500)).toBeNull();
    expect(linkRectPct([100, 50, 300, 150], 0, 500)).toBeNull();
    expect(linkRectPct([100, 50], 1000, 500)).toBeNull();
  });
});

describe("resolveDestSlide", () => {
  const pdf = {
    getDestination: async (name: string) =>
      name === "known" ? [{ num: 7, gen: 0 }, { name: "XYZ" }] : null,
    getPageIndex: async (ref: { num: number }) => {
      if (ref.num !== 7) throw new Error("no such page");
      return 3;
    },
  } as unknown as PDFDocumentProxy;

  it("resolves a named destination to a 1-based slide", async () => {
    expect(await resolveDestSlide(pdf, "known")).toBe(4);
  });

  it("resolves an explicit destination array", async () => {
    expect(await resolveDestSlide(pdf, [{ num: 7, gen: 0 }, { name: "Fit" }])).toBe(4);
  });

  it("treats a numeric first entry as a page index", async () => {
    expect(await resolveDestSlide(pdf, [2, { name: "Fit" }])).toBe(3);
  });

  it("returns null for destinations it cannot resolve", async () => {
    expect(await resolveDestSlide(pdf, "unknown")).toBeNull();
    expect(await resolveDestSlide(pdf, [{ num: 99, gen: 0 }])).toBeNull();
    expect(await resolveDestSlide(pdf, [])).toBeNull();
    expect(await resolveDestSlide(pdf, null)).toBeNull();
  });
});
