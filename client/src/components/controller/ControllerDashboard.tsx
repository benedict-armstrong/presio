import type { ReactNode } from "react";
import { Mosaic, MosaicWindow, type MosaicNode } from "react-mosaic-component";
import { X } from "lucide-react";
import { CARD_LABELS } from "@/lib/controllerLayout";
import "react-mosaic-component/react-mosaic-component.css";
import "@/pages/controllerMosaic.css";

export interface CardEntry {
  content: ReactNode;
  action?: ReactNode;
}

// Desktop body: the draggable/resizable tiling dashboard. Each tile's header is
// our own toolbar (also the drag handle) with the card title, an optional action
// (e.g. timer settings), and a hide button.
export function ControllerDashboard({
  value,
  onChange,
  cards,
  onHideCard,
}: {
  value: MosaicNode<string> | null;
  onChange: (node: MosaicNode<string> | null) => void;
  cards: Record<string, CardEntry>;
  onHideCard: (key: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <Mosaic<string>
        className="controller-mosaic"
        value={value}
        onChange={onChange}
        renderTile={(key, path) => (
          <MosaicWindow<string>
            path={path}
            title={CARD_LABELS[key]}
            renderToolbar={() => (
              <div className="flex items-center justify-between w-full px-3 py-1.5 cursor-move select-none">
                <span className="text-xs text-muted-foreground font-semibold">{CARD_LABELS[key]}</span>
                <div className="flex items-center gap-1">
                  {cards[key].action}
                  <button
                    type="button"
                    onClick={() => onHideCard(key)}
                    title="Hide card"
                    className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            )}
          >
            <div className="h-full flex flex-col p-3 pt-1">
              <div className="flex-1 min-h-0">{cards[key].content}</div>
            </div>
          </MosaicWindow>
        )}
        zeroStateView={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            All cards hidden — enable them in Settings.
          </div>
        }
      />
    </div>
  );
}
