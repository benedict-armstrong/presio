import { socket } from "./socket";

// NTP-style clock offset estimation against the server.
// We exchange (t1, serverTime, t2) timestamps and estimate the offset between
// the client clock and the server clock, plus the round-trip time.
//   offset = serverTime - (t1 + t2) / 2
//   rtt    = t2 - t1
// Both are smoothed with EWMA after the first sample. Subsequent samples that
// look way worse than the current RTT are ignored as outliers.

let offsetMs = 0;
let rttMs = 0;
let initialised = false;
let started = false;

const PING_INTERVAL = 30_000;
const INITIAL_BURST = 4;
const INITIAL_BURST_GAP = 250;

const EWMA_ALPHA = 0.3;

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
}

// Fold one ping exchange into the running estimate.
//   rtt    = t2 - t1
//   offset = serverTime - (t1 + t2) / 2
// The first sample seeds the estimate directly; later samples are smoothed with
// an EWMA, and a sample whose RTT is a wild outlier (e.g. an RTT spike from tab
// throttling) is rejected by returning `prev` unchanged.
export function computeSample(
  t1: number,
  t2: number,
  serverTime: number,
  prev: ClockSample | null
): ClockSample {
  const r = t2 - t1;
  const o = serverTime - (t1 + t2) / 2;
  if (!prev) return { offsetMs: o, rttMs: r };
  if (r > prev.rttMs * 4 + 200) return prev;
  return {
    offsetMs: prev.offsetMs * (1 - EWMA_ALPHA) + o * EWMA_ALPHA,
    rttMs: prev.rttMs * (1 - EWMA_ALPHA) + r * EWMA_ALPHA,
  };
}

export function startClockSync() {
  if (started) return;
  started = true;
  // Fire a burst of pings on start to converge quickly.
  for (let i = 0; i < INITIAL_BURST; i++) {
    setTimeout(ping, i * INITIAL_BURST_GAP);
  }
  window.setInterval(ping, PING_INTERVAL);
  // If the socket reconnects mid-session, re-sync.
  socket.on("connect", () => {
    initialised = false;
    for (let i = 0; i < INITIAL_BURST; i++) {
      setTimeout(ping, i * INITIAL_BURST_GAP);
    }
  });
}

function ping() {
  if (!socket.connected) return;
  const t1 = Date.now();
  socket.emit(
    "time_ping",
    t1,
    (resp: { serverTime: number; clientT1: number } | undefined) => {
      if (!resp) return;
      const t2 = Date.now();
      const next = computeSample(t1, t2, resp.serverTime, initialised ? { offsetMs, rttMs } : null);
      offsetMs = next.offsetMs;
      rttMs = next.rttMs;
      initialised = true;
    }
  );
}

/** Server-time approximation in milliseconds. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
