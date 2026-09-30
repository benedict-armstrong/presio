import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SESSION_CODE_LENGTH } from "@shared/session";
import { sessionPath } from "@/lib/joinUrl";

/**
 * One box per character of a join code. Typing, pasting and backspacing move
 * between boxes; a complete code joins as a viewer straight away.
 */
export function JoinCodeInput() {
  const navigate = useNavigate();
  const [chars, setChars] = useState<string[]>(Array(SESSION_CODE_LENGTH).fill(""));
  const charRefs = useRef<(HTMLInputElement | null)[]>([]);
  const code = chars.join("");

  useEffect(() => {
    if (code.length === SESSION_CODE_LENGTH) navigate(sessionPath(code, "viewer"));
  }, [code, navigate]);

  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: SESSION_CODE_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            charRefs.current[i] = el;
          }}
          type="text"
          inputMode="text"
          maxLength={1}
          value={chars[i]}
          className="h-12 w-10 rounded-md border border-input bg-background text-center font-mono text-lg font-bold uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
          onChange={(e) => {
            const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (!val) return;
            const next = [...chars];
            next[i] = val[val.length - 1];
            setChars(next);
            if (i < SESSION_CODE_LENGTH - 1) charRefs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              const next = [...chars];
              if (chars[i]) {
                next[i] = "";
                setChars(next);
              } else if (i > 0) {
                next[i - 1] = "";
                setChars(next);
                charRefs.current[i - 1]?.focus();
              }
            } else if (e.key === "ArrowLeft" && i > 0) {
              charRefs.current[i - 1]?.focus();
            } else if (e.key === "ArrowRight" && i < SESSION_CODE_LENGTH - 1) {
              charRefs.current[i + 1]?.focus();
            } else if (e.key === "Enter" && code.length === SESSION_CODE_LENGTH) {
              navigate(sessionPath(code, "viewer"));
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "");
            const next = [...chars];
            for (let j = 0; j < SESSION_CODE_LENGTH - i && j < pasted.length; j++) {
              next[i + j] = pasted[j];
            }
            setChars(next);
            const focusIdx = Math.min(i + pasted.length, SESSION_CODE_LENGTH - 1);
            charRefs.current[focusIdx]?.focus();
          }}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
