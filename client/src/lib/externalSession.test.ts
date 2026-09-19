// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock our own pdf module so loadExternalPdfMeta doesn't actually fetch/parse
// a PDF. openPdf/destroyPdf are the seam the app loads documents through (they
// own the pdf.js loading task), so stubbing them here also keeps the pdf.js
// worker side-effect out of the test environment.
//
// We capture the source openPdf was asked for to assert URL normalization.
const openPdf = vi.fn();
const destroyPdf = vi.fn();
vi.mock("@/lib/pdf", () => ({
  openPdf: (arg: unknown) => openPdf(arg),
  destroyPdf: (arg: unknown) => destroyPdf(arg),
}));

import { loadExternalPdfMeta } from "./externalSession";

function mockPdf(numPages: number) {
  openPdf.mockResolvedValue({ numPages });
}

describe("loadExternalPdfMeta", () => {
  beforeEach(() => {
    openPdf.mockReset();
    destroyPdf.mockReset();
  });

  it("rewrites a github.com blob URL to raw.githubusercontent.com", async () => {
    mockPdf(5);
    const meta = await loadExternalPdfMeta(
      "https://github.com/me/repo/blob/main/slides/deck.pdf"
    );
    expect(openPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://raw.githubusercontent.com/me/repo/main/slides/deck.pdf",
      })
    );
    expect(meta.url).toBe(
      "https://raw.githubusercontent.com/me/repo/main/slides/deck.pdf"
    );
    expect(meta.totalSlides).toBe(5);
    expect(meta.filename).toBe("deck");
    // The document is released once its page count has been read.
    expect(destroyPdf).toHaveBeenCalled();
  });

  it("rewrites a github.com raw URL too", async () => {
    mockPdf(1);
    const meta = await loadExternalPdfMeta(
      "https://github.com/me/repo/raw/main/a.pdf"
    );
    expect(meta.url).toBe("https://raw.githubusercontent.com/me/repo/main/a.pdf");
  });

  it("passes non-github HTTPS URLs through unchanged", async () => {
    mockPdf(3);
    const meta = await loadExternalPdfMeta("https://example.com/files/talk.pdf");
    expect(openPdf).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/files/talk.pdf" })
    );
    expect(meta.url).toBe("https://example.com/files/talk.pdf");
    expect(meta.filename).toBe("talk");
  });

  it("falls back to 'Presentation' when no usable filename", async () => {
    mockPdf(2);
    const meta = await loadExternalPdfMeta("https://example.com/");
    expect(meta.filename).toBe("Presentation");
  });

  it("rejects non-https URLs", async () => {
    await expect(loadExternalPdfMeta("http://example.com/x.pdf")).rejects.toThrow(
      /https/
    );
    expect(openPdf).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs", async () => {
    await expect(loadExternalPdfMeta("not a url")).rejects.toThrow(/valid URL/);
  });

  it("throws a friendly error when the PDF fails to load", async () => {
    openPdf.mockRejectedValue(new Error("CORS"));
    await expect(
      loadExternalPdfMeta("https://example.com/x.pdf")
    ).rejects.toThrow(/Couldn't load a PDF/);
  });
});
