"use client";

import { useEffect, useState } from "react";
import { labelRelayUrl } from "@/lib/label-printing";

export default function LabelRelayStatus({ printerId }: { printerId: string }) {
  const [status, setStatus] = useState("Connecting to label relay…");
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      socket = new WebSocket(labelRelayUrl());
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "heartbeat") socket.send(JSON.stringify({ type: "heartbeat" }));
        if (message.type === "status") {
          const relay = message.relays.find((item: { printerIds: string[] }) => item.printerIds.includes(printerId));
          setStatus(relay ? `Relay ready: ${relay.name}` : "No relay online for this printer. Open Label Relay Mode on the laptop.");
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setStatus("Relay connection unavailable. Reconnecting…");
        timer = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket.close(); };
  }, [printerId]);
  return <p className="text-sm" role="status">{status}</p>;
}
