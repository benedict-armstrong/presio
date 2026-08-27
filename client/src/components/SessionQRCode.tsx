import { QRCodeSVG } from "qrcode.react";
import { useJoinUrl } from "@/lib/joinUrl";

export function SessionQRCode({
  sessionId,
  size = 200,
  url,
  shareable,
}: {
  sessionId: string;
  size?: number;
  /** Supplied by surfaces that already resolved the join URL, so the QR and the
   *  links beside it can never disagree. Resolved here otherwise. */
  url?: string;
  shareable?: boolean;
}) {
  const own = useJoinUrl(sessionId, "viewer");
  const viewerUrl = url ?? own.url;
  const canShare = shareable ?? own.shareable;
  return (
    <div className="text-center space-y-3">
      {canShare ? (
        <>
          <p className="text-xs text-muted-foreground">Scan to join as viewer</p>
          <div className="flex justify-center">
            <QRCodeSVG value={viewerUrl} size={size} className="rounded" />
          </div>
        </>
      ) : (
        // A QR built from a loopback origin sends the scanning phone back to
        // itself, so there is nothing worth rendering until an address is known.
        <p className="text-xs text-muted-foreground">
          Set this machine&apos;s network address below to show a QR code.
        </p>
      )}
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground">Session Code</p>
        <p className="text-2xl font-bold tracking-widest font-mono select-all">
          {sessionId}
        </p>
      </div>
    </div>
  );
}
