import { useEffect, useState } from "react";
import { getHighlighter } from "@/lib/highlighter";

type Lang = "typst" | "latex";

interface CodeBlockProps {
  code: string;
  lang?: Lang;
}

export function CodeBlock({ code, lang = "typst" }: CodeBlockProps) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((hl) =>
        hl.codeToHtml(code, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          // Emit CSS variables so the `.dark` class swaps themes for us.
          defaultColor: false,
        })
      )
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => { /* fall back to the plain <pre> below */ });
    return () => { cancelled = true; };
  }, [code, lang]);

  // Until highlighting resolves (or if it fails), show the raw snippet so the
  // page never flashes empty.
  if (!html) {
    return (
      <pre className="bg-muted rounded-md p-3 overflow-x-auto text-xs font-mono whitespace-pre">
        {code}
      </pre>
    );
  }

  return (
    <div
      className="text-xs rounded-md overflow-x-auto border border-border dark:border-transparent [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
