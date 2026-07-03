import { useState, useEffect, useCallback } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SettingsGearButton } from "./SettingsGearButton";

// Presenter-side timer preferences. Purely a device-local concern (persisted in
// localStorage by the controller) — never synced to the server or viewers.
export interface TimerSettings {
  mode: "up" | "down";
  /** Countdown start, in seconds. Only meaningful in "down" mode. */
  duration: number | null;
  /** Warning point, in seconds: "down" = remaining time, "up" = elapsed time. */
  threshold: number | null;
}

interface TimerState {
  running: boolean;
  startedAt: number | null;
  accumulated: number;
}

function loadTimerState(id: string): TimerState {
  try {
    const raw = localStorage.getItem(`presio_timer_${id}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { running: false, startedAt: null, accumulated: 0 };
}

function saveTimerState(id: string, state: TimerState) {
  localStorage.setItem(`presio_timer_${id}`, JSON.stringify(state));
}

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function elapsedOf(t: TimerState): number {
  return t.running && t.startedAt
    ? t.accumulated + Math.floor((Date.now() - t.startedAt) / 1000)
    : t.accumulated;
}

/** Elapsed-seconds stopwatch persisted per session, shared by the desktop card
 *  and the mobile footer readout. */
function useSessionTimer(id: string) {
  const [timer, setTimer] = useState<TimerState>(() => loadTimerState(id));
  const [elapsed, setElapsed] = useState(() => elapsedOf(loadTimerState(id)));

  useEffect(() => {
    if (!timer.running) return;
    const interval = setInterval(() => setElapsed(elapsedOf(timer)), 1000);
    return () => clearInterval(interval);
  }, [timer]);

  useEffect(() => {
    saveTimerState(id, timer);
  }, [id, timer]);

  const start = useCallback(() => {
    setTimer((t) => t.running ? t : { ...t, running: true, startedAt: Date.now() });
  }, []);

  const stop = useCallback(() => {
    if (!timer.running) return;
    const total = elapsedOf(timer);
    setTimer({ running: false, startedAt: null, accumulated: total });
    setElapsed(total);
  }, [timer]);

  const reset = useCallback(() => {
    setTimer({ running: false, startedAt: null, accumulated: 0 });
    setElapsed(0);
  }, []);

  return { elapsed, running: timer.running, start, stop, reset };
}

// Map elapsed seconds through the settings: what to display and how far into
// the warning zone we are (0 = none, ramping to 1 = fully overdue).
function timerReadout(elapsed: number, settings: TimerSettings): { seconds: number; warning: number } {
  const threshold = settings.threshold ?? 0;
  if (settings.mode === "down" && settings.duration) {
    const remaining = Math.max(0, settings.duration - elapsed);
    if (remaining === 0) return { seconds: 0, warning: 1 };
    if (threshold > 0 && remaining <= threshold) {
      return { seconds: remaining, warning: 1 - remaining / threshold };
    }
    return { seconds: remaining, warning: 0 };
  }
  if (threshold > 0 && elapsed >= threshold) {
    // Ramp to full red over the minute after the warning point.
    return { seconds: elapsed, warning: Math.min(1, (elapsed - threshold) / 60) };
  }
  return { seconds: elapsed, warning: 0 };
}

const warningStyle = (warning: number) =>
  warning > 0 ? { color: `hsl(${(1 - warning) * 30}, 90%, 50%)` } : undefined;

const inputCls = "w-14 rounded-md border border-input bg-background px-1.5 py-1 text-xs text-center placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function TimerCard({
  id,
  settings,
  showClock = false,
}: {
  id: string;
  settings: TimerSettings;
  /** Also show the current wall-clock time under the elapsed timer. */
  showClock?: boolean;
}) {
  const { elapsed, running, start, stop, reset } = useSessionTimer(id);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!showClock) return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [showClock]);

  const { seconds, warning } = timerReadout(elapsed, settings);

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex flex-col items-center justify-center flex-1 gap-2">
        <span
          className="font-mono tabular-nums text-2xl font-semibold transition-colors duration-500"
          style={warningStyle(warning)}
        >
          {formatTime(seconds)}
        </span>
        {showClock && (
          <span data-testid="timer-clock" className="font-mono tabular-nums text-sm text-muted-foreground">
            {formatClock(now)}
          </span>
        )}
        <div className="flex gap-1.5">
          {running ? (
            <Button size="sm" variant="outline" onClick={stop}>Stop</Button>
          ) : (
            <Button size="sm" variant="outline" onClick={start}>Start</Button>
          )}
          <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>
        </div>
      </div>
    </div>
  );
}

/** Compact tap-to-start/stop readout of the same per-session timer, for the
 *  mobile controller footer. */
export function MobileTimer({ id, settings }: { id: string; settings: TimerSettings }) {
  const { elapsed, running, start, stop } = useSessionTimer(id);
  const { seconds, warning } = timerReadout(elapsed, settings);

  return (
    <button
      type="button"
      onClick={running ? stop : start}
      title={running ? "Stop timer" : "Start timer"}
      className={`font-mono tabular-nums text-xs font-medium transition-colors duration-500 ${
        running ? "" : "text-muted-foreground"
      }`}
      style={warningStyle(warning)}
    >
      {formatTime(seconds)}
    </button>
  );
}

export function TimerSettingsDialog({
  settings,
  onSettingsChange,
  showClock,
  onShowClockChange,
  onClose,
}: {
  settings: TimerSettings;
  onSettingsChange: (s: TimerSettings) => void;
  showClock: boolean;
  onShowClockChange: (show: boolean) => void;
  onClose: () => void;
}) {
  const updateSetting = (patch: Partial<TimerSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  const durMin = settings.duration ? String(Math.floor(settings.duration / 60)) : "";
  const durSec = settings.duration ? String(settings.duration % 60) : "";
  const thrMin = settings.threshold ? String(Math.floor(settings.threshold / 60)) : "";
  const thrSec = settings.threshold ? String(settings.threshold % 60) : "";

  const parseDuration = (min: string, sec: string) => {
    const v = (parseInt(min || "0", 10) * 60) + parseInt(sec || "0", 10);
    return v > 0 ? v : null;
  };

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-xs">
      <h2 className="text-lg font-semibold">Timer Settings</h2>
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium">Mode</label>
          <div className="flex gap-1">
            {(["up", "down"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => updateSetting({ mode: m })}
                className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                  settings.mode === m
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input hover:bg-accent"
                }`}
              >
                {m === "up" ? "Count up" : "Count down"}
              </button>
            ))}
          </div>
        </div>
        {settings.mode === "down" && (
          <div className="space-y-1">
            <label className="text-xs font-medium">Duration</label>
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="999" placeholder="mm" value={durMin}
                onChange={(e) => updateSetting({ duration: parseDuration(e.target.value, durSec) })}
                className={inputCls} />
              <span className="text-muted-foreground text-xs">:</span>
              <input type="number" min="0" max="59" placeholder="ss" value={durSec}
                onChange={(e) => updateSetting({ duration: parseDuration(durMin, e.target.value) })}
                className={inputCls} />
            </div>
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs font-medium">Warning</label>
          <div className="flex items-center gap-1">
            <input type="number" min="0" max="999" placeholder="mm" value={thrMin}
              onChange={(e) => updateSetting({ threshold: parseDuration(e.target.value, thrSec) })}
              className={inputCls} />
            <span className="text-muted-foreground text-xs">:</span>
            <input type="number" min="0" max="59" placeholder="ss" value={thrSec}
              onChange={(e) => updateSetting({ threshold: parseDuration(thrMin, e.target.value) })}
              className={inputCls} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {settings.mode === "down"
              ? "Turns the timer red when this much time remains."
              : "Turns the timer red after this much time has passed."}
          </p>
        </div>
        <button
          type="button"
          data-testid="timer-show-clock"
          onClick={() => onShowClockChange(!showClock)}
          className="flex items-center gap-2 w-full px-0.5 py-1 text-xs font-medium rounded hover:bg-accent transition-colors text-left"
        >
          <span
            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
              showClock ? "bg-primary border-primary text-primary-foreground" : "border-input"
            }`}
          >
            {showClock && <Check size={11} strokeWidth={3} />}
          </span>
          Show current time
        </button>
      </div>
      <Button className="w-full" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </DialogOverlay>
  );
}

export function TimerAction({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return <SettingsGearButton open={open} onToggle={onToggle} title="Timer settings" />;
}
