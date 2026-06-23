import { Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "@/components/ui/button";
import { PresioLogo } from "@/components/PresioLogo";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { MobileControllerMenu } from "@/components/MobileControllerMenu";
import { PresentationTimer } from "@/components/PresentationTimer";
import { NextSlideCard } from "./NextSlideCard";
import type { PresentationSettings } from "@/pages/Presentation";

export function MobileControllerLayout({
  id,
  local,
  pdfUrl,
  pdf,
  currentSlide,
  totalSlides,
  onGoTo,
  onSyncAll,
  currentCanvasRef,
  settings,
  startedAt,
  passphrase,
}: {
  id: string;
  local: boolean;
  pdfUrl: string;
  pdf: PDFDocumentProxy;
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  onSyncAll: () => void;
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
  settings: PresentationSettings;
  startedAt: number;
  passphrase: string;
}) {
  return (
    <div className="h-dvh bg-background flex flex-col">
      <div className="border-b px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link to="/" className="flex items-center gap-1.5 text-sm font-semibold hover:text-muted-foreground transition-colors">
            <PresioLogo className="h-4 w-auto" />
            Presio
          </Link>
          <span className="text-muted-foreground/40">|</span>
          {!local && (
            <span className="font-mono font-bold tracking-widest text-sm select-all">{id}</span>
          )}
          <ConnectionIndicator local={local} />
          {local && <span className="text-xs font-medium text-amber-600 dark:text-amber-500">Local</span>}
        </div>
        <MobileControllerMenu id={id} pdf={pdf} pdfUrl={pdfUrl} passphrase={passphrase} />
      </div>

      <div className="flex-1 flex flex-col gap-2 p-3 min-h-0">
        <div className="flex-3 flex flex-col gap-1 min-h-0">
          <p className="text-xs text-muted-foreground font-medium">Current</p>
          <div
            ref={currentCanvasRef}
            className="flex-1 border rounded-lg overflow-hidden bg-white min-h-0"
          />
        </div>
        <div className="flex-2 flex flex-col gap-1 min-h-0">
          <p className="text-xs text-muted-foreground font-medium">Next</p>
          <NextSlideCard pdf={pdf} currentSlide={currentSlide} totalSlides={totalSlides} />
        </div>
      </div>

      <div className="border-t px-3 py-3 space-y-2">
        <div className="flex items-center justify-center gap-3">
          <PresentationTimer
            mode={settings.timerMode}
            duration={settings.timerDuration}
            threshold={settings.timerThreshold}
            startedAt={startedAt}
            className="text-xs font-medium"
          />
          <p className="text-center text-xs text-muted-foreground tabular-nums">
            {currentSlide} / {totalSlides}
          </p>
          {!local && (
            <Button variant="ghost" size="sm" onClick={onSyncAll}>
              Sync All
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            className="flex-1 h-12 text-base"
            variant="outline"
            onClick={() => onGoTo(currentSlide - 1)}
            disabled={currentSlide <= 1}
          >
            Previous
          </Button>
          <Button
            className="flex-1 h-12 text-base"
            variant="outline"
            onClick={() => onGoTo(currentSlide + 1)}
            disabled={currentSlide >= totalSlides}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
