import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { LEASE_MS, MAX_CONCURRENT, MAX_QUEUE, MAX_RESPONSE_BYTES, subjectFromBody, validateRequest } from "./protocol.mjs";

export function controlKey(secret) {
  if (!secret || secret.length < 32) throw new Error("API relay requires a SESSION_SECRET of at least 32 characters.");
  return createHash("sha256").update(`temco-api-relay-control-v1:${secret}`).digest("hex");
}
const digest = (token) => createHash("sha256").update(token).digest("hex");
const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
const fault = (message, status = 400) => Object.assign(new Error(message), { status });

export function createApiRelayServer({ secret, allowedOrigins = [], heartbeatMs = 10000, leaseMs = LEASE_MS, pairMs = 90000, maxConcurrent = MAX_CONCURRENT, maxQueue = MAX_QUEUE }) {
  const key = controlKey(secret);
  const tokens = new Map();
  const connections = new Map();
  const leases = new Map();
  // JSON can encode one text byte as six bytes (\u0000, for example).
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RESPONSE_BYTES * 6 + 65536, perMessageDeflate: false });
  const leaseKey = ({ userId, sessionId }) => JSON.stringify([userId, sessionId]);
  const live = (owner) => (leases.get(leaseKey(owner)) || 0) > Date.now();
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  const renew = (owner) => {
    const id = leaseKey(owner);
    const previous = leases.get(id);
    if (previous !== undefined && previous <= Date.now()) {
      for (const [hash, t] of tokens) if (leaseKey(t.owner) === id) tokens.delete(hash);
      for (const c of connections.values()) if (leaseKey(c.owner) === id) disconnect(c, "Temco session lease expired. Pair again.");
    }
    leases.set(id, Date.now() + leaseMs);
  };
  const owned = (owner, id) => {
    const c = connections.get(id);
    if (!c || c.owner.userId !== owner.userId || !live(c.owner)) throw fault("DMP connection is unavailable.", 404);
    return c;
  };
  const complete = (c, id, result) => {
    const job = c.pending.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    c.pending.delete(id);
    job.resolve(result);
    dispatch(c);
  };
  const disconnect = (c, message = "DMP relay disconnected. Requests were not retried; check DMP before repeating an operation.") => {
    connections.delete(c.id);
    clearTimeout(c.identityTimer);
    // Remove all jobs before resolving; none can be dispatched during teardown.
    const jobs = [...c.pending.values()];
    c.pending.clear();
    for (const job of jobs) { clearTimeout(job.timer); job.resolve({ ok: false, error: message }); }
    c.ws.close(1000, "Relay ended");
  };
  const dispatch = (c) => {
    if (!connections.has(c.id) || !c.ready || !live(c.owner) || c.ws.readyState !== WebSocket.OPEN) return;
    let running = [...c.pending.values()].filter((j) => j.started).length;
    for (const [requestId, job] of c.pending) {
      if (job.started || running >= maxConcurrent) continue;
      running++;
      job.started = true;
      clearTimeout(job.timer);
      job.timer = setTimeout(() => {
        // A timed-out fetch may already have changed DMP; never replay it.
        send(c.ws, { type: "cancel", requestId });
        complete(c, requestId, { ok: false, error: "DMP request timed out. It was not retried; its outcome may be uncertain." });
      }, job.request.timeoutMs + 1000);
      send(c.ws, { type: "request", requestId, request: job.request });
    }
  };
  const read = async (req) => {
    let bytes = 0;
    const parts = [];
    for await (const part of req) {
      bytes += part.length;
      if (bytes > 200000) throw fault("Control request is too large.", 413);
      parts.push(part);
    }
    try { return JSON.parse(Buffer.concat(parts).toString()); } catch { throw fault("Invalid control request."); }
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") { json(res, 200, { ok: true }); return; }
    if (req.url !== "/control" || req.method !== "POST") { json(res, 404, { error: "Not found." }); return; }
    const supplied = req.headers["x-api-relay-key"];
    const suppliedBytes = Buffer.from(typeof supplied === "string" ? supplied : "");
    const keyBytes = Buffer.from(key);
    if (suppliedBytes.length !== keyBytes.length || !timingSafeEqual(suppliedBytes, keyBytes)) { json(res, 401, { error: "Unauthorized." }); return; }
    try {
      const { action, owner, ...data } = await read(req);
      if (!owner || typeof owner.userId !== "string" || !owner.userId || typeof owner.sessionId !== "string" || !owner.sessionId) throw fault("Authenticated owner is required.", 401);
      if (action === "revoke") {
        leases.delete(leaseKey(owner));
        for (const [hash, t] of tokens) if (leaseKey(t.owner) === leaseKey(owner)) tokens.delete(hash);
        for (const c of connections.values()) if (leaseKey(c.owner) === leaseKey(owner)) disconnect(c, "Temco session ended. Pair again after signing in.");
        json(res, 200, { ok: true }); return;
      }
      renew(owner);
      if (action === "lease") { json(res, 200, { ok: true }); return; }
      if (action === "pair") {
        if (!allowedOrigins.includes(data.origin)) throw fault("This DMP origin is not configured.");
        const identity = validateRequest(data.identity);
        if (identity.method !== "GET" || typeof data.subjectPath !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(data.subjectPath)) throw fault("Configure the DMP identity endpoint.");
        if ([...tokens.values()].filter((t) => t.owner.userId === owner.userId).length >= 8 || [...connections.values()].filter((c) => c.owner.userId === owner.userId).length >= 8 || tokens.size >= 1024) throw fault("Too many DMP pairings. Disconnect an existing tab first.", 429);
        const token = randomBytes(32).toString("base64url");
        tokens.set(digest(token), { owner, origin: data.origin, identity, subjectPath: data.subjectPath, expires: Date.now() + pairMs });
        json(res, 200, { token, expiresIn: pairMs / 1000 }); return;
      }
      if (action === "connections") {
        json(res, 200, { connections: [...connections.values()].filter((c) => c.owner.userId === owner.userId && live(c.owner)).map((c) => ({ id: c.id, origin: c.origin, ready: c.ready, dmpUser: c.subject || null, pending: c.pending.size, connectedAt: c.connectedAt })) }); return;
      }
      const c = owned(owner, data.connectionId);
      if (action === "disconnect") { disconnect(c); json(res, 200, { ok: true }); return; }
      if (action !== "request") throw fault("Unknown API relay action.");
      if (!c.ready) throw fault("DMP identity is still being checked.", 409);
      if (c.pending.size >= maxQueue) throw fault("DMP request queue is full.", 429);
      const request = validateRequest(data.request);
      const requestId = randomUUID();
      const result = await new Promise((resolve) => {
        c.pending.set(requestId, { request, resolve, started: false, timer: setTimeout(() => complete(c, requestId, { ok: false, error: "DMP request expired in the queue without being sent." }), 60000) });
        dispatch(c);
        res.on("close", () => {
          if (res.writableEnded || !c.pending.has(requestId)) return;
          send(c.ws, { type: "cancel", requestId });
          complete(c, requestId, { ok: false, error: "Caller disconnected." });
        });
      });
      if (!res.destroyed) json(res, 200, { requestId, ...result });
    } catch (error) { if (!res.destroyed) json(res, error.status || 400, { error: error.message || "API relay failed." }); }
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    // DMP has no Temco cookie. Ownership is established by a one-use token in
    // the first frame, never in a URL, browser storage, or Origin alone.
    if (req.url !== "/api/api-relay/ws" || !allowedOrigins.includes(req.headers.origin) || wss.clients.size >= 1024) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let c;
      const timer = setTimeout(() => ws.close(1008, "Pairing timed out"), 5000);
      ws.on("error", () => {});
      ws.on("pong", () => { if (c) c.lastSeen = Date.now(); });
      ws.on("message", (raw, binary) => {
        try {
          if (binary) throw fault("JSON messages required.");
          const m = JSON.parse(raw.toString());
          if (!c) {
            if (m.type !== "pair" || typeof m.token !== "string" || m.token.length !== 43) throw fault("Pairing required.");
            const hash = digest(m.token);
            const t = tokens.get(hash);
            if (!t || t.expires <= Date.now() || !live(t.owner) || t.origin !== req.headers.origin) throw fault("Pairing expired.");
            tokens.delete(hash);
            clearTimeout(timer);
            c = { id: randomUUID(), ws, owner: t.owner, origin: t.origin, identity: t.identity, subjectPath: t.subjectPath, ready: false, pending: new Map(), lastSeen: Date.now(), connectedAt: new Date().toISOString(), expires: Date.now() + 8 * 60 * 60 * 1000 };
            connections.set(c.id, c);
            send(ws, { type: "paired", connectionId: c.id, identity: c.identity, subjectPath: c.subjectPath, maxConcurrent, maxResponseBytes: MAX_RESPONSE_BYTES });
            c.identityTimer = setTimeout(() => disconnect(c, "DMP identity check timed out."), c.identity.timeoutMs + 1000);
            return;
          }
          if (!live(c.owner)) { disconnect(c, "Temco session expired. Pair again."); return; }
          if (m.type === "identity" && !c.ready) {
            if (typeof m.subject !== "string" || !m.subject || m.subject.length > 256) throw fault("DMP identity is missing.");
            c.subject = m.subject;
            c.ready = true;
            clearTimeout(c.identityTimer);
            send(ws, { type: "ready", dmpUser: c.subject }); dispatch(c); return;
          }
          if (m.type === "identity-changed") { disconnect(c, "DMP account changed or signed out. Pair again."); return; }
          if (m.type !== "result") throw fault("Unknown message.");
          const job = c.pending.get(m.requestId);
          if (!job?.started) return; // Late or foreign request IDs never settle a job.
          if (m.ok === false) { complete(c, m.requestId, { ok: false, error: String(m.error || "DMP request failed.").slice(0, 500) }); return; }
          if (m.ok !== true || !Number.isInteger(m.status) || m.status < 100 || m.status > 599 || typeof m.body !== "string" || Buffer.byteLength(m.body) > MAX_RESPONSE_BYTES || m.subject !== c.subject) throw fault("Invalid DMP response.");
          // Identity responses are checked by the broker as well as the browser.
          if (job.request.path === c.identity.path && subjectFromBody(m.body, c.subjectPath) !== c.subject) { disconnect(c, "DMP identity changed. Pair again."); return; }
          complete(c, m.requestId, { ok: true, status: m.status, contentType: typeof m.contentType === "string" ? m.contentType.slice(0, 200) : "", body: m.body });
        } catch { if (c) disconnect(c, "Invalid DMP relay message."); else ws.close(1008, "Invalid pairing"); }
      });
      ws.on("close", () => { clearTimeout(timer); if (c) { clearTimeout(c.identityTimer); disconnect(c); } });
    });
  });
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [hash, t] of tokens) if (t.expires <= now || !live(t.owner)) tokens.delete(hash);
    for (const [id, expires] of leases) if (expires <= now) leases.delete(id);
    for (const c of connections.values()) {
      if (!live(c.owner) || c.expires <= now || now - c.lastSeen > heartbeatMs * 3) disconnect(c, "Relay session expired. Pair again.");
      else c.ws.ping();
    }
  }, heartbeatMs);
  interval.unref();
  return { server, close: () => {
    clearInterval(interval);
    for (const c of [...connections.values()]) { clearTimeout(c.identityTimer); disconnect(c); }
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createApiRelayServer({ secret: process.env.SESSION_SECRET, allowedOrigins: (process.env.DMP_ORIGINS ?? "https://dmp.extapps.homedepot.com").split(",").map((s) => s.trim()).filter(Boolean) });
  relay.server.listen(Number(process.env.API_RELAY_PORT || 3003), process.env.API_RELAY_HOST || "127.0.0.1", () => console.log("API relay listening"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
}
