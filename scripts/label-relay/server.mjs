import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const uncertain = "Relay connection lost or timed out. Check the printer before printing again; the label may have been sent.";

// Authentication and printer destinations remain owned by the Next app. The relay
// never accepts a destination URL from a scanner and never contacts a printer.
export function createRelayServer({ authenticate, origin, jobTimeout = 15000, queueTimeout = 45000, heartbeatInterval = 10000 }) {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end(req.url === "/health" ? "ok" : "Not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const clients = new Map();
  const pending = new Map();
  const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const available = () => [...clients].filter(([ws, client]) => ws.readyState === WebSocket.OPEN && client.relay && Date.now() - client.lastSeen < heartbeatInterval * 3);
  const status = () => ({ type: "status", relays: available().map(([, client]) => ({ name: client.name, printerIds: client.printerIds })) });
  const broadcast = () => { for (const ws of clients.keys()) send(ws, status()); };
  const dispatch = (receiver) => {
    const jobs = [...pending.entries()].filter(([, job]) => job.receiver === receiver);
    if (receiver.readyState !== WebSocket.OPEN || jobs.some(([, job]) => job.started)) return;
    const next = jobs.find(([, job]) => !job.started);
    if (!next) return;
    const [jobId, job] = next;
    job.started = true;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      // Stop this receiver before releasing queued jobs: the last delivery is uncertain.
      receiver.close(1011, "Print acknowledgement timed out");
      finish(jobId, false, uncertain);
    }, jobTimeout);
    send(receiver, { type: "job", jobId, printer: job.printer, zpl: job.zpl });
  };
  const finish = (id, ok, error) => {
    const job = pending.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(id);
    send(job.sender, { type: "result", requestId: job.requestId, ok, error, relayName: job.relayName });
    dispatch(job.receiver);
  };

  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    if (req.url !== "/api/label-relay/ws" || req.headers.origin !== origin) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const session = await authenticate(req.headers.cookie || "");
      if (!session) throw new Error("Unauthorized");
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { cookie: req.headers.cookie || "", session, relay: false, printerIds: [], name: "", lastSeen: Date.now(), requests: new Set(), handling: false };
        clients.set(ws, client);
        ws.on("error", () => {});
        ws.on("message", async (data, binary) => {
          let message;
          try { message = binary ? null : JSON.parse(data.toString()); } catch { /* invalid JSON */ }
          if (!message || typeof message !== "object") { ws.close(1008, "Invalid message"); return; }
          if (message.type === "heartbeat") { client.lastSeen = Date.now(); return; }
          if (message.type === "result") {
            const job = pending.get(message.jobId);
            if (job?.receiver === ws && job.started && typeof message.ok === "boolean") {
              finish(message.jobId, message.ok, message.ok ? undefined : String(message.error || "The relay could not send the label.").slice(0, 500));
            }
            return;
          }
          // Bound concurrent auth work and outstanding jobs on each connection.
          if (client.handling) { ws.close(1008, "Wait for the previous request"); return; }
          client.handling = true;
          try {
            const current = await authenticate(client.cookie);
            if (!current) { ws.close(1008, "Sign in again"); return; }
            if (ws.readyState !== WebSocket.OPEN) return;
            client.session = current;
            if (message.type === "register") {
              if (!Array.isArray(message.printerIds) || !message.printerIds.length || message.printerIds.some((id) => !current.printers.some((printer) => printer.id === id))) {
                send(ws, { type: "error", error: "Select at least one active printer for this laptop." });
                return;
              }
              client.relay = true;
              client.printerIds = [...new Set(message.printerIds)];
              client.name = typeof message.name === "string" ? message.name.trim().slice(0, 80) || "Label relay laptop" : "Label relay laptop";
              send(ws, { type: "registered" });
              broadcast();
              return;
            }
            if (message.type !== "print") { ws.close(1008, "Unknown message"); return; }
            const { requestId, printerId, zpl } = message;
            if (typeof requestId !== "string" || requestId.length > 80 || !requestId || typeof zpl !== "string" || !zpl.trim() || Buffer.byteLength(zpl) > 128 * 1024) {
              ws.close(1008, "Invalid print request"); return;
            }
            const fail = (error) => send(ws, { type: "result", requestId, ok: false, error });
            if (client.requests.has(requestId)) { fail("This request was already submitted. Check the printer before printing again."); return; }
            if (client.requests.size >= 100) { fail("Reconnect before submitting more labels."); return; }
            client.requests.add(requestId);
            const printer = current.printers.find((item) => item.id === printerId);
            if (!printer) { fail("The selected printer is no longer active. Reload label configuration."); return; }
            // One receiver per job, even if several laptops serve this printer.
            const receiver = available().filter(([, relay]) => relay.printerIds.includes(printerId)).sort(([a], [b]) =>
              [...pending.values()].filter((job) => job.receiver === a).length - [...pending.values()].filter((job) => job.receiver === b).length
            )[0];
            if (!receiver) { fail(`No label relay is online for ${printer.name}. Enable Label Relay Mode on a laptop serving this printer.`); return; }
            const [relaySocket, relay] = receiver;
            if (pending.size >= 256 || [...pending.values()].filter((job) => job.receiver === relaySocket).length >= 8) { fail("The label relay queue is full. Wait for its current labels to finish, then try again."); return; }
            const jobId = randomUUID();
            pending.set(jobId, { sender: ws, receiver: relaySocket, requestId, relayName: relay.name, printer, zpl, started: false, timer: setTimeout(() => finish(jobId, false, "Relay queue timed out before sending this label. Try again when the laptop is ready."), queueTimeout) });
            dispatch(relaySocket);
          } catch {
            send(ws, { type: "error", error: "Unable to verify the relay session. Sign in again or try later." });
          } finally { client.handling = false; }
        });
        ws.on("close", () => {
          clients.delete(ws);
          for (const [id, job] of pending) {
            if (job.receiver === ws) finish(id, false, job.started ? uncertain : "Relay disconnected before sending this label. Reconnect the laptop and try again.");
            else if (job.sender === ws && !job.started) {
              clearTimeout(job.timer);
              pending.delete(id);
            }
            // Keep a dispatched job reserved even if its sender disconnects.
            // It must not be retried or reassigned: printing may already have begun.
          }
          broadcast();
        });
        send(ws, { type: "hello" });
        send(ws, status());
      });
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  let checking = false;
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await Promise.all([...clients].map(async ([ws, client]) => {
        if (Date.now() - client.lastSeen >= heartbeatInterval * 3) { ws.terminate(); return; }
        try {
          const session = await authenticate(client.cookie);
          if (!session) { ws.close(1008, "Sign in again"); return; }
          client.printerIds = client.printerIds.filter((id) => session.printers.some((printer) => printer.id === id));
          send(ws, { type: "heartbeat" });
        } catch { ws.close(1011, "Session check failed"); }
      }));
      broadcast();
    } finally { checking = false; }
  }, heartbeatInterval);
  interval.unref();
  return { server, close: () => {
    clearInterval(interval);
    for (const job of pending.values()) clearTimeout(job.timer);
    pending.clear();
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
    return new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appUrl = process.env.RELAY_APP_URL || "http://127.0.0.1:3000";
  const relay = createRelayServer({
    origin: process.env.RELAY_ORIGIN || "http://localhost:3000",
    authenticate: async (cookie) => {
      const response = await fetch(`${appUrl}/api/label-relay/session`, { headers: { cookie }, redirect: "error", signal: AbortSignal.timeout(5000) });
      return response.ok ? response.json() : null;
    },
  });
  relay.server.listen(Number(process.env.RELAY_PORT || 3002), process.env.RELAY_HOST || "127.0.0.1", () => console.log("Label relay listening"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
}
