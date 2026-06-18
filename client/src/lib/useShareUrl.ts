import { useState } from "react";
import { idbDelete } from "@/lib/localStore";
import { loadExternalPdfMeta, shareLocalSessionViaUrl } from "@/lib/externalSession";

// Converts a local session into an externally-hosted ("bring your own storage")
// one, keeping the same code. The presenter supplies the URL where they now host
// the PDF; we validate it loads, flip the row server-side, and drop the local
// IndexedDB copy so future loads use the external URL. Mirrors useClaim.
export function useShareUrl(id: string) {
  const [converting, setConverting] = useState(false);
  const [shareUrlError, setShareUrlError] = useState("");

  const shareViaUrl = async (rawUrl: string): Promise<boolean> => {
    setShareUrlError("");
    setConverting(true);
    try {
      const meta = await loadExternalPdfMeta(rawUrl);
      await shareLocalSessionViaUrl(id, meta);
      await idbDelete(id).catch(() => { /* ignore */ });
      return true;
    } catch (e: unknown) {
      setShareUrlError(e instanceof Error ? e.message : "Failed to share presentation");
      return false;
    } finally {
      setConverting(false);
    }
  };

  return { converting, shareUrlError, shareViaUrl };
}
