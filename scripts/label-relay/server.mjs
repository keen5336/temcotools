import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const uncertain = "Relay connection lost or timed out. Check the printer before printing again; the label may have been sent.";

// Authentication and printer destinations remain owned by the Next app. The relay
// never accepts a destination URL from a scanner and never contacts a printer.
export function createRelayServer({ authenticate, origin, authorizeDispatch, recordDelivery, cancelQueued, jobTimeout = 15000, queueTimeout = 45000, heartbeatInterval = 10000 }) {
  if (authorizeDispatch && (!recordDelivery || !cancelQueued)) throw new Error("Managed relay requires durable dispatch, result and queued-cancellation callbacks.");
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end(req.url === "/health" ? "ok" : "Not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const clients = new Map();
  const pending = new Map();
  let closing = false;
  const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const available = () => [...clients].filter(([ws, client]) => ws.readyState === WebSocket.OPEN && client.relay && Date.now() - client.lastSeen < heartbeatInterval * 3);
  const status = () => ({ type: "status", relays: available().map(([, client]) => ({ name: client.name, printerIds: client.printerIds, deviceId: client.deviceId })) });
  const broadcast = () => { for (const ws of clients.keys()) send(ws, status()); };
  const dispatch = async (receiver) => {
    if (closing) return;
    const jobs = [...pending.entries()].filter(([, job]) => job.receiver === receiver);
    if (receiver.readyState !== WebSocket.OPEN || jobs.some(([, job]) => job.started || job.authorizing || job.finishing)) return;
    const next = jobs.find(([, job]) => !job.started);
    if (!next) return;
    const [jobId, job] = next;
    job.authorizing = true;
    clearTimeout(job.timer);
    try {
      const sender = clients.get(job.sender), target = clients.get(receiver);
      const [requester, deviceUser] = await Promise.all([sender && authenticate(sender.cookie), target && authenticate(target.cookie)]);
      if (!requester || !deviceUser || !requester.printers.some(printer => printer.id === job.printer.id) || !deviceUser.printers.some(printer => printer.id === job.printer.id)) throw new Error("Current requester/device permission changed before dispatch.");
      if (authorizeDispatch) {
        const claim = await authorizeDispatch({ cookie: target.cookie, issuanceId: job.issuanceId, deviceId: target.deviceId, deviceToken: target.deviceToken, printerId: job.printer.id });
        if (!claim?.dispatch) { await finish(jobId, false, "This issuance was already claimed or completed. Read its original receipt; it was not replayed."); return; }
        job.dispatchClaim = claim;
        if (!pending.has(jobId) || receiver.readyState !== WebSocket.OPEN) {
          if (recordDelivery) await recordDelivery({ cookie: target.cookie, claim, deviceToken: target.deviceToken, status: "not_sent", note: "Relay disconnected before the approved payload was delivered to the device." });
          return;
        }
        job.printer = claim.printer; job.zpl = claim.zpl;
      }
      if (!pending.has(jobId) || receiver.readyState !== WebSocket.OPEN) return;
    } catch {
      await finish(jobId, false, "Current label authorization could not be confirmed before dispatch. Read the original issuance receipt before trying again.");
      return;
    }
    job.authorizing = false;
    job.started = true;
    job.timer = setTimeout(() => {
      // Stop this receiver before releasing queued jobs: the last delivery is uncertain.
      receiver.close(1011, "Print acknowledgement timed out");
      void finish(jobId, false, uncertain, "unknown");
    }, jobTimeout);
    send(receiver, { type: "job", jobId, printer: job.printer, zpl: job.zpl, dispatch: job.dispatchClaim });
  };
  const finish = async (id, ok, error, deliveryStatus) => {
    const job = pending.get(id);
    if (!job || job.finishing) return;
    job.finishing = true;
    clearTimeout(job.timer);
    if (authorizeDispatch) {
      try {
        if (job.started && job.dispatchClaim && recordDelivery) {
          const target = clients.get(job.receiver);
          await recordDelivery({ cookie: target?.cookie || job.receiverCookie, claim: job.dispatchClaim, deviceToken: target?.deviceToken || job.receiverDeviceToken, status: deliveryStatus || (ok ? "sent_unconfirmed" : "unknown"), note: ok ? "Relay device reported browser/network send completion; physical output remains unconfirmed." : String(error || uncertain).slice(0, 500) });
        } else if (cancelQueued) {
          const sender = clients.get(job.sender);
          await cancelQueued({ cookie: sender?.cookie || job.senderCookie, issuanceId: job.issuanceId, reason: String(error || "Relay stopped before device dispatch.").slice(0, 500) });
        }
      } catch { ok = false; error = "The durable print result could not be confirmed. Inspect the original issuance and physical printer; no replay occurred."; }
    }
    pending.delete(id);
    send(job.sender, { type: "result", requestId: job.requestId, ok, error, relayName: job.relayName });
    void dispatch(job.receiver);
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
        const client = { cookie: req.headers.cookie || "", session, relay: false, printerIds: [], deviceId: undefined, deviceToken: undefined, name: "", lastSeen: Date.now(), requests: new Set(), handling: false };
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
              void finish(message.jobId, message.ok, message.ok ? undefined : String(message.error || "The relay could not send the label.").slice(0, 500), message.deliveryStatus === "not_sent" ? "not_sent" : message.ok ? "sent_unconfirmed" : "unknown");
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
              if (authorizeDispatch && (typeof message.deviceId !== "string" || typeof message.deviceToken !== "string")) { send(ws, { type: "error", error: "Register this laptop as an authorized printing device first." }); return; }
              client.relay = true;
              client.deviceId = message.deviceId; client.deviceToken = message.deviceToken;
              client.printerIds = [...new Set(message.printerIds)];
              client.name = typeof message.name === "string" ? message.name.trim().slice(0, 80) || "Label relay laptop" : "Label relay laptop";
              send(ws, { type: "registered" });
              broadcast();
              return;
            }
            if (message.type !== "print") { ws.close(1008, "Unknown message"); return; }
            const { requestId, printerId, zpl } = message;
            if (authorizeDispatch && (typeof message.issuanceId !== "string" || message.issuanceId.length > 100 || typeof message.deviceId !== "string" || message.deviceId.length > 100)) { ws.close(1008, "A managed label issuance/device is required"); return; }
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
            const receiver = available().filter(([, relay]) => relay.printerIds.includes(printerId) && (!authorizeDispatch || relay.deviceId === message.deviceId)).sort(([a], [b]) =>
              [...pending.values()].filter((job) => job.receiver === a).length - [...pending.values()].filter((job) => job.receiver === b).length
            )[0];
            if (!receiver) { fail(`No label relay is online for ${printer.name}. Enable Label Relay Mode on a laptop serving this printer.`); return; }
            const [relaySocket, relay] = receiver;
            if (pending.size >= 256 || [...pending.values()].filter((job) => job.receiver === relaySocket).length >= 8) { fail("The label relay queue is full. Wait for its current labels to finish, then try again."); return; }
            const jobId = randomUUID();
            pending.set(jobId, { sender: ws, receiver: relaySocket, requestId, relayName: relay.name, printer, zpl, issuanceId: message.issuanceId, senderCookie: client.cookie, receiverCookie: relay.cookie, receiverDeviceToken: relay.deviceToken, started: false, authorizing: false, timer: setTimeout(() => void finish(jobId, false, "Relay queue timed out before sending this label. Try again when the laptop is ready."), queueTimeout) });
            void dispatch(relaySocket);
          } catch {
            send(ws, { type: "error", error: "Unable to verify the relay session. Sign in again or try later." });
          } finally { client.handling = false; }
        });
        ws.on("close", () => {
          clients.delete(ws);
          for (const [id, job] of pending) {
            if (job.receiver === ws) void finish(id, false, job.started ? uncertain : "Relay disconnected before sending this label. Reconnect the laptop and try again.");
            else if (job.sender === ws && !job.started) {
              void finish(id, false, "Requester disconnected before this label was sent.");
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
  return { server, close: async () => {
    closing = true;
    clearInterval(interval);
    await Promise.all([...pending].map(([id, job]) => finish(id, false, job.started ? uncertain : "Relay stopped before label dispatch.", job.started ? "unknown" : "not_sent")));
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
    return new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appUrl = process.env.RELAY_APP_URL || "http://localhost:3000";
  const origin = process.env.RELAY_ORIGIN || "http://localhost:3000";
  const control = async (cookie, path, body) => {
    const response = await fetch(`${appUrl}${path}`, { method: "POST", headers: { cookie, origin, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (!response.ok) throw new Error("Label application authorization/result unavailable.");
    return result;
  };
  const relay = createRelayServer({
    origin,
    authorizeDispatch: ({ cookie, issuanceId, deviceId, deviceToken }) => control(cookie, "/api/labels/dispatch", { action: "claim", issuanceId, deviceId, deviceToken }),
    recordDelivery: ({ cookie, claim, deviceToken, status, note }) => control(cookie, "/api/labels/dispatch", { action: "report", issuanceId: claim.issuanceId, deviceId: claim.deviceId, deviceToken, reportToken: claim.reportToken, status, note }),
    cancelQueued: ({ cookie, issuanceId, reason }) => control(cookie, `/api/labels/issuances/${encodeURIComponent(issuanceId)}`, { action: "cancel", reason }),
    authenticate: async (cookie) => {
      const response = await fetch(`${appUrl}/api/label-relay/session`, { headers: { cookie }, redirect: "error", signal: AbortSignal.timeout(5000) });
      return response.ok ? response.json() : null;
    },
  });
  relay.server.listen(Number(process.env.RELAY_PORT || 3002), process.env.RELAY_HOST || "127.0.0.1", () => console.log("Label relay listening"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
}
