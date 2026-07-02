import { useState, useEffect, useCallback } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import type { PresentationSettings } from "@/pages/Presentation";
import { SettingsGearButton } from "./SettingsGearButton";

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

const inputCls = "w-14 rounded-md border border-input bg-background px-1.5 py-1 text-xs text-center placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function TimerCard({
  id,
  showClock = false,
}: {
  id: string;
  /** Also show the current wall-clock time under the elapsed timer. */
  showClock?: boolean;
}) {
  const [timer, setTimer] = useState<TimerState>(() => loadTimerState(id));
  const [display, setDisplay] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!showClock) return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [showClock]);

  const computeElapsed = useCallback(() => {
    if (timer.running && timer.startedAt) {
      return timer.accumulated + Math.floor((Date.now() - timer.startedAt) / 1000);
    }
    return timer.accumulated;
  }, [timer]);

  useEffect(() => {
    setDisplay(computeElapsed());
    if (!timer.running) return;
    const interval = setInterval(() => setDisplay(computeElapsed()), 1000);
    return () => clearInterval(interval);
  }, [timer, computeElapsed]);

  useEffect(() => {
    saveTimerState(id, timer);
  }, [id, timer]);

  const start = () => {
    setTimer((t) => t.running ? t : { ...t, running: true, startedAt: Date.now() });
  };

  const stop = () => {
    setTimer((t) => {
      if (!t.running) return t;
      const extra = t.startedAt ? Math.floor((Date.now() - t.startedAt) / 1000) : 0;
      return { running: false, startedAt: null, accumulated: t.accumulated + extra };
    });
  };

  const reset = () => {
    setTimer({ running: false, startedAt: null, accumulated: 0 });
  };

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex flex-col items-center justify-center flex-1 gap-2">
        <span className="font-mono tabular-nums text-2xl font-semibold">
          {formatTime(display)}
        </span>
        {showClock && (
          <span data-testid="timer-clock" className="font-mono tabular-nums text-sm text-muted-foreground">
            {formatClock(now)}
          </span>
        )}
        <div className="flex gap-1.5">
          {timer.running ? (
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

type TimerMode = "off" | "up" | "down";

export function TimerSettingsDialog({
  settings,
  onSettingsChange,
  showClock,
  onShowClockChange,
  onClose,
}: {
  settings: PresentationSettings;
  onSettingsChange: (s: PresentationSettings) => void;
  showClock: boolean;
  onShowClockChange: (show: boolean) => void;
  onClose: () => void;
}) {
  const timerMode: TimerMode = (settings.timerMode ?? "off") as TimerMode;

  const updateSetting = (patch: Partial<PresentationSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  const durMin = settings.timerDuration ? String(Math.floor(settings.timerDuration / 60)) : "";
  const durSec = settings.timerDuration ? String(settings.timerDuration % 60) : "";
  const thrMin = settings.timerThreshold ? String(Math.floor(settings.timerThreshold / 60)) : "";
  const thrSec = settings.timerThreshold ? String(settings.timerThreshold % 60) : "";

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
            {(["off", "up", "down"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => updateSetting({ timerMode: m === "off" ? null : m })}
                className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                  timerMode === m
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input hover:bg-accent"
                }`}
              >
                {m === "off" ? "Off" : m === "up" ? "Up" : "Down"}
              </button>
            ))}
          </div>
        </div>
        {timerMode !== "off" && (
          <>
            {timerMode === "down" && (
              <div className="space-y-1">
                <label className="text-xs font-medium">Duration</label>
                <div className="flex items-center gap-1">
                  <input type="number" min="0" max="999" placeholder="mm" value={durMin}
                    onChange={(e) => updateSetting({ timerDuration: parseDuration(e.target.value, durSec) })}
                    className={inputCls} />
                  <span className="text-muted-foreground text-xs">:</span>
                  <input type="number" min="0" max="59" placeholder="ss" value={durSec}
                    onChange={(e) => updateSetting({ timerDuration: parseDuration(durMin, e.target.value) })}
                    className={inputCls} />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium">Warning</label>
              <div className="flex items-center gap-1">
                <input type="number" min="0" max="999" placeholder="mm" value={thrMin}
                  onChange={(e) => updateSetting({ timerThreshold: parseDuration(e.target.value, thrSec) })}
                  className={inputCls} />
                <span className="text-muted-foreground text-xs">:</span>
                <input type="number" min="0" max="59" placeholder="ss" value={thrSec}
                  onChange={(e) => updateSetting({ timerThreshold: parseDuration(thrMin, e.target.value) })}
                  className={inputCls} />
              </div>
            </div>
          </>
        )}
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
