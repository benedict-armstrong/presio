import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { getDocument } from "pdfjs-dist";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountControl } from "@/components/AccountControl";
import { PresioLogo } from "@/components/PresioLogo";
import { idbPut, idbList, idbDelete, idbPruneOlderThan } from "@/lib/localStore";
import { supabase } from "@/lib/supabaseClient";
import "@/lib/pdf"; // ensure pdf.js worker is configured

const LOCAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface RecentSession {
  id: string;
  filename: string;
  hasToken: boolean;
  local?: boolean;
}

export default function Home() {
  const navigate = useNavigate();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const CODE_LENGTH = 6;
  const [chars, setChars] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const charRefs = useRef<(HTMLInputElement | null)[]>([]);
  const code = chars.join("");
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<RecentSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Local presentations stored in IndexedDB — drop stale ones first.
      await idbPruneOlderThan(LOCAL_TTL_MS).catch(() => { /* ignore */ });
      const localRecents: RecentSession[] = (await idbList().catch(() => []))
        .map((m) => ({ id: m.id, filename: m.filename, hasToken: true, local: true }));

      // Server-backed presentations tracked via localStorage tokens.
      const sessionKeys = Object.keys(localStorage).filter((k) => k.startsWith("session_"));
      const serverRecents = await Promise.all(
        sessionKeys.map(async (key) => {
          const id = key.replace("session_", "");
          try {
            const res = await fetch(`/api/sessions/${id}`);
            if (!res.ok) {
              localStorage.removeItem(key);
              return null;
            }
            const session = await res.json();
            const stored = JSON.parse(localStorage.getItem(key) || "{}");
            return { id, filename: session.filename, hasToken: !!stored.controllerToken } as RecentSession;
          } catch {
            return null;
          }
        })
      );

      if (!cancelled) {
        setRecentSessions([
          ...localRecents,
          ...serverRecents.filter((r): r is RecentSession => r !== null),
        ]);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const upload = useCallback(async (file: File) => {
    setError("");
    setUploading(true);
    setProgress(0);
    try {
      // Everyone defaults to local: keep the PDF in the browser, never upload it.
      // We reserve a session code on the server (marked local) so it is unique.
      // Logged-in users can opt into syncing later from the share screen.
      const bytes = new Uint8Array(await file.arrayBuffer());
      setProgress(100);
      const doc = await getDocument({ data: bytes }).promise;
      const totalSlides = doc.numPages;
      doc.destroy();
      const filename = file.name.replace(/\.pdf$/i, "");
      // If the user is logged in, send their token so the server assigns the
      // presentation to them right away (getSession refreshes a near-expiry one).
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData.session) headers.Authorization = `Bearer ${sessionData.session.access_token}`;
      const res = await fetch("/api/sessions/local", {
        method: "POST",
        headers,
        body: JSON.stringify({ filename, total_slides: totalSlides }),
      });
      if (!res.ok) throw new Error("Failed to create session");
      const { id } = await res.json();
      try {
        await idbPut({ id, filename, totalSlides, blob: file, createdAt: Date.now() });
      } catch {
        throw new Error("Couldn't store the presentation in this browser. Private/incognito mode isn't supported — please use a normal window.");
      }
      navigate(`/s/${id}/share`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [navigate]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file?.type === "application/pdf") upload(file);
      else setError("Please drop a PDF file");
    },
    [upload]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  }, []);

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) upload(file);
    },
    [upload]
  );

  const joinSession = (role: string) => {
    if (code.length < CODE_LENGTH) return;
    navigate(`/s/${code}?role=${role}`);
  };

  const removeRecent = async (s: RecentSession) => {
    if (s.local) await idbDelete(s.id).catch(() => { /* ignore */ });
    else localStorage.removeItem(`session_${s.id}`);
    setRecentSessions((prev) => prev.filter((r) => r.id !== s.id));
  };

  const handleRemove = (s: RecentSession) => {
    // Local presentations live only in this browser, so removing them is
    // permanent — confirm first. Server-backed ones just drop the local token.
    if (s.local) setConfirmRemove(s);
    else removeRecent(s);
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 gap-4"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Card className="w-full max-w-lg">
        <CardContent className="pt-6 space-y-6">
          <div className="text-center space-y-2">
            <div className="flex items-center justify-center gap-2">
              <PresioLogo className="h-6 w-auto text-foreground" />
              <h1 className="text-2xl font-semibold tracking-tight">Presio</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Upload a PDF presentation to start presenting
            </p>
          </div>

          <div
            className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer ${
              dragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
            onClick={() => document.getElementById("file-input")?.click()}
          >
            {uploading ? (
              <div className="space-y-2 w-full max-w-xs mx-auto">
                <p className="text-muted-foreground text-sm">
                  {progress < 100 ? `Uploading… ${progress}%` : "Processing…"}
                </p>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Drop a PDF here or click to browse</p>
            )}
            <input
              id="file-input"
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={onFileSelect}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or join existing</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2 justify-center">
              {Array.from({ length: CODE_LENGTH }, (_, i) => (
                <input
                  key={i}
                  ref={(el) => { charRefs.current[i] = el; }}
                  type="text"
                  inputMode="text"
                  maxLength={1}
                  value={chars[i]}
                  className="w-10 h-12 rounded-md border border-input bg-background text-center text-lg font-mono font-bold uppercase tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                  onChange={(e) => {
                    const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                    if (!val) return;
                    const next = [...chars];
                    next[i] = val[val.length - 1];
                    setChars(next);
                    if (i < CODE_LENGTH - 1) charRefs.current[i + 1]?.focus();
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
                    } else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
                      charRefs.current[i + 1]?.focus();
                    } else if (e.key === "Enter" && code.length === CODE_LENGTH) {
                      joinSession("viewer");
                    }
                  }}
                  onPaste={(e) => {
                    e.preventDefault();
                    const pasted = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "");
                    const next = [...chars];
                    for (let j = 0; j < CODE_LENGTH - i && j < pasted.length; j++) {
                      next[i + j] = pasted[j];
                    }
                    setChars(next);
                    const focusIdx = Math.min(i + pasted.length, CODE_LENGTH - 1);
                    charRefs.current[focusIdx]?.focus();
                  }}
                  onFocus={(e) => e.target.select()}
                />
              ))}
            </div>
            {code.length === CODE_LENGTH && (
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={() => joinSession("viewer")}
                >
                  Join as Viewer
                </Button>
                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={() => joinSession("controller")}
                >
                  Join as Controller
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {recentSessions.length > 0 && (
        <Card className="w-full max-w-lg">
          <CardContent className="pt-6 space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Recent presentations
            </p>
            {recentSessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {s.filename}
                    {s.local && (
                      <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground border rounded px-1 py-0.5">
                        Local
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">{s.id}</p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {s.hasToken && (
                    <Button size="sm" variant="outline" onClick={() => navigate(`/s/${s.id}?role=controller`)}>
                      Control
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => navigate(`/s/${s.id}?role=viewer`)}>
                    View
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleRemove(s)} title="Remove">
                    ✕
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Link
          to="/about"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
        >
          How does Presio work?
        </Link>
        <AccountControl />
        <ThemeToggle />
      </div>

      {confirmRemove && (
        <DialogOverlay onClose={() => setConfirmRemove(null)}>
          <div className="space-y-2 text-center">
            <h2 className="text-lg font-semibold">Delete presentation?</h2>
            <p className="text-sm text-muted-foreground">
              This presentation is stored only in this browser and will be
              permanently deleted. This action cannot be undone.
            </p>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              variant="destructive"
              onClick={() => {
                removeRecent(confirmRemove);
                setConfirmRemove(null);
              }}
            >
              Delete
            </Button>
          </div>
        </DialogOverlay>
      )}

    </div>
  );
}
