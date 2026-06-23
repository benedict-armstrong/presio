// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pdfjs-dist so loadExternalPdfMeta doesn't actually fetch/parse a PDF.
// We capture the URL it was asked to load to assert URL normalization.
const getDocument = vi.fn();
vi.mock("pdfjs-dist", () => ({
  getDocument: (arg: unknown) => getDocument(arg),
}));
// `@/lib/pdf` is imported for its worker side-effect only; stub it out.
vi.mock("@/lib/pdf", () => ({}));

import { loadExternalPdfMeta } from "./externalSession";

function mockPdf(numPages: number) {
  getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages, destroy: vi.fn() }),
  });
}

describe("loadExternalPdfMeta", () => {
  beforeEach(() => getDocument.mockReset());

  it("rewrites a github.com blob URL to raw.githubusercontent.com", async () => {
    mockPdf(5);
    const meta = await loadExternalPdfMeta(
      "https://github.com/me/repo/blob/main/slides/deck.pdf"
    );
    expect(getDocument).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/me/repo/main/slides/deck.pdf"
    );
    expect(meta.url).toBe(
      "https://raw.githubusercontent.com/me/repo/main/slides/deck.pdf"
    );
    expect(meta.totalSlides).toBe(5);
    expect(meta.filename).toBe("deck");
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
    expect(getDocument).toHaveBeenCalledWith("https://example.com/files/talk.pdf");
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
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("rejects malformed URLs", async () => {
    await expect(loadExternalPdfMeta("not a url")).rejects.toThrow(/valid URL/);
  });

  it("throws a friendly error when the PDF fails to load", async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error("CORS")) });
    await expect(
      loadExternalPdfMeta("https://example.com/x.pdf")
    ).rejects.toThrow(/Couldn't load a PDF/);
  });
});
