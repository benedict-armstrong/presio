import { Fragment, useState, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { cn } from "@/lib/utils";

export interface SettingsCategory {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar group heading; categories sharing one are listed under it. */
  group?: string;
  /** Shown muted in the sidebar (e.g. a plugin that's switched off). */
  dimmed?: boolean;
  /** Optional line under the pane's title. */
  description?: string;
  /** Rendered beside the pane's title (e.g. a reset button). */
  action?: ReactNode;
  content: ReactNode;
}

/**
 * The controller's Settings: a sidebar of categories and one pane at a time.
 * On a phone the sidebar becomes a scrolling strip of tabs above the pane.
 * The selection can be controlled (so a caller can jump to a category it just
 * created, like a newly added plugin) or left to the dialog.
 */
export function SettingsDialog({
  categories,
  onClose,
  footer,
  activeId: controlledId,
  onActiveChange,
}: {
  categories: SettingsCategory[];
  onClose: () => void;
  /** Small print under the sidebar (the build version). */
  footer?: ReactNode;
  activeId?: string;
  onActiveChange?: (id: string) => void;
}) {
  const [ownId, setOwnId] = useState(categories[0]?.id);
  const activeId = controlledId ?? ownId;
  const select = (id: string) => {
    setOwnId(id);
    onActiveChange?.(id);
  };
  // A category can disappear while open (a plugin removed, sharing ended).
  const active = categories.find((c) => c.id === activeId) ?? categories[0];

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-3xl" bare>
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-base font-semibold">Settings</h2>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close settings"
          className="-mr-1.5 inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-col sm:flex-row min-h-0 sm:h-[min(560px,75dvh)]">
        <nav
          aria-label="Settings categories"
          className="flex sm:flex-col gap-0.5 shrink-0 overflow-x-auto sm:overflow-y-auto border-b sm:border-b-0 sm:border-r px-3 py-2 sm:py-3 sm:w-52"
        >
          {categories.map((category, i) => {
            const Icon = category.icon;
            const selected = category.id === active?.id;
            const startsGroup = category.group && category.group !== categories[i - 1]?.group;
            return (
              <Fragment key={category.id}>
                {startsGroup && (
                  <div className="hidden sm:block px-2.5 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {category.group}
                  </div>
                )}
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  data-testid={`settings-tab-${category.id}`}
                  onClick={() => select(category.id)}
                  className={cn(
                    "flex items-center gap-2.5 shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm text-left transition-colors",
                    selected
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                    category.dimmed && !selected && "opacity-60"
                  )}
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="truncate">{category.label}</span>
                </button>
              </Fragment>
            );
          })}
          {footer && <div className="hidden sm:block mt-auto px-2.5 pt-4">{footer}</div>}
        </nav>

        {active && (
          <section
            className="flex-1 min-w-0 overflow-y-auto px-5 py-4 space-y-4"
            aria-label={active.label}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <h3 className="text-base font-semibold leading-tight">{active.label}</h3>
                {active.description && <p className="text-sm text-muted-foreground">{active.description}</p>}
              </div>
              {active.action}
            </div>
            {active.content}
          </section>
        )}
      </div>

      {footer && <div className="sm:hidden border-t px-5 py-2">{footer}</div>}
    </DialogOverlay>
  );
}
