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
      const r = t2 - t1;
      const o = resp.serverTime - (t1 + t2) / 2;
      if (!initialised) {
        offsetMs = o;
        rttMs = r;
        initialised = true;
      } else {
        // Reject crazy outliers (e.g. RTT spike from tab throttling)
        if (r > rttMs * 4 + 200) return;
        const a = 0.3;
        offsetMs = offsetMs * (1 - a) + o * a;
        rttMs = rttMs * (1 - a) + r * a;
      }
    }
  );
}

/** Server-time approximation in milliseconds. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
