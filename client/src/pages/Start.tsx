import { useEffect, useState } from "react";
import { useParams, useSearchParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { idbPut } from "@/lib/localStore";
import { setSessionAuth } from "@/lib/sessionAuth";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Deep link from POST /api/present: /start/:id?t=<token>
// Pulls the staged PDF into IndexedDB (local session), clears the server copy,
// and opens the controller — skipping the share screen.
export default function Start() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("t") || "";
  const [loadError, setLoadError] = useState("");
  const error = !id || !token ? "Missing session id or token." : loadError;

  useEffect(() => {
    let cancelled = false;
    if (!id || !token) return;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${id}/handoff?t=${encodeURIComponent(token)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === "string" ? body.error : "Failed to download presentation");
        }
        // Percent-encoded by the server: header values can't carry non-Latin-1.
        const filename = safeDecode(res.headers.get("X-Filename") || "") || "presentation";
        const totalSlides = parseInt(res.headers.get("X-Total-Slides") || "0", 10);
        const blob = await res.blob();
        if (!totalSlides) throw new Error("Invalid presentation metadata");
        try {
          await idbPut({ id, filename, totalSlides, blob, createdAt: Date.now() });
        } catch {
          throw new Error("Couldn't store the presentation in this browser. Private/incognito mode isn't supported — please use a normal window.");
        }
        // Remember the token this link carried: it's the only proof this browser
        // is the controller. In local/offline mode there are no accounts, so
        // sharing the deck over the network later (useClaim) authorizes with
        // exactly this token — without it the sync button could only ever fail
        // with "this browser isn't the controller".
        setSessionAuth(id, { controllerToken: token });

        await fetch(`/api/sessions/${id}/handoff/complete`, {
          method: "POST",
          headers: { "x-controller-token": token },
        });
        if (!cancelled) navigate(`/s/${id}?role=controller`, { replace: true });
      } catch (e: unknown) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to start presentation");
      }
    })();
    return () => { cancelled = true; };
  }, [id, token, navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-4 text-center">
            <p className="text-3xl">😕</p>
            <h2 className="text-lg font-semibold">{error}</h2>
            <Button asChild className="w-full">
              <Link to="/">Back to Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-muted-foreground">Starting presentation…</p>
    </div>
  );
}
