import { io } from "socket.io-client";

export const socket = io("/", {
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 1000,
  // Cap the backoff so a dropped connection retries at least every 5s rather
  // than drifting toward a long delay. A faster watchdog in Presentation also
  // nudges reconnection in case socket.io's own retries stall.
  reconnectionDelayMax: 5000,
});
