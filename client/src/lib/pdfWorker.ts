// Polyfills must run inside the worker too — the main thread's don't reach it.
import "../polyfills";
import "pdfjs-dist/build/pdf.worker.mjs";
