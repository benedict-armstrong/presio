import { useState, useEffect } from "react";
import { socket } from "@/lib/socket";

export function ConnectionIndicator({ dark = false, local = false }: { dark?: boolean; local?: boolean }) {
  const [socketConnected, setSocketConnected] = useState(socket.connected);

  useEffect(() => {
    if (local) return;
    const onConnect = () => setSocketConnected(true);
    const onDisconnect = () => setSocketConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [local]);

  // Local presentations have no server connection — they're "connected" via the
  // same-browser BroadcastChannel. Show amber to distinguish them from a live
  // server connection (green); a dropped server connection is red.
  const connected = local || socketConnected;
  const pingColor = local ? "bg-amber-400" : "bg-green-400";
  const dotColor = local
    ? "bg-amber-500"
    : socketConnected
      ? "bg-green-500"
      : dark ? "bg-red-400" : "bg-red-500";

  return (
    <span
      className="relative flex h-2.5 w-2.5"
      title={local ? "Local — synced to other windows in this browser only" : socketConnected ? "Connected" : "Disconnected"}
    >
      {connected && (
        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingColor}`} />
      )}
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${dotColor}`} />
    </span>
  );
}
