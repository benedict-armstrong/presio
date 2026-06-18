// Fine-grained Shiki bundle: only the languages/themes the About page needs,
// so we don't pull in Shiki's full grammar/theme set.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import typst from "shiki/langs/typst.mjs";
import latex from "shiki/langs/latex.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import githubDark from "shiki/themes/github-dark.mjs";

let highlighterPromise: Promise<HighlighterCore> | null = null;

// Created once and shared across every CodeBlock on the page.
export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [typst, latex],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  return highlighterPromise;
}
