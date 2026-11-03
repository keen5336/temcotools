import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { assertProviderAction, assertProviderBinding, providerPathMatches, readProviderIdentity } from "../../lib/integrations/browser-executor.mjs";
const fault = (message, status = 403) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
const hash = value => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
const send = (ws, value) => { if (ws.readyState !== WebSocket.OPEN) throw fault("Original provider socket ended.", 409); ws.send(JSON.stringify(value)); };
const ownerOf = binding => ({ ...binding.owner, siteId: binding.siteId });
const keyOf = row => ({ siteId: row.siteId, operationId: row.operationId });
const publicReceipt = row => ({ operationId: row.operationId, providerId: row.providerId, actionVersionId: row.actionVersionId, state: row.state, revision: row.revision, requestId: row.requestId ?? null, mayReplay: false });
const validActor = actor => actor && Object.keys(actor).every(key => ["userId", "sessionId", "siteId", "deviceId", "tabId", "grantId", "authVersion"].includes(key)) && [actor.userId, actor.sessionId, actor.siteId].every(v => typeof v === "string" && v.length > 0 && v.length <= 200) && [actor.deviceId, actor.tabId, actor.grantId].every(v => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 200)) && (actor.authVersion === undefined || (Number.isSafeInteger(actor.authVersion) && actor.authVersion > 0));
const sameOwner = (actor, binding) => validActor(actor) && !actor.grantId && actor.userId === binding.owner.userId && actor.sessionId === binding.owner.sessionId && actor.siteId === binding.siteId;
const viewOf = (binding, action) => ({ binding, ...(action ? { action } : {}) });
/**
 * Trusted bridge only: authorize must LOAD current server authority and canonical definitions.
 * operations callbacks are REQUIRED durable storage, never this hub's maps. enqueue/claim
 * must invoke recheck(tx) inside their atomic writer, after locking original records.
 */
export function createGenericProviderHub({ audience, mode = "read_only_dmp", authorize, operations, observe = async (event) => { void event; }, verifyIdentity = async (result, binding) => readProviderIdentity(result, binding.identity), now = Date.now, pairMs = 90000, leaseMs = 120000, heartbeatMs = 10000, maxQueue = 8, maxProviders = 128 }) {
  if (typeof audience !== "string" || !audience || audience.length > 200 || !["read_only_dmp", "live", "synthetic"].includes(mode) || typeof authorize !== "function" || !operations || ["get", "enqueue", "claim", "settle", "appendEvidence"].some(name => typeof operations[name] !== "function") || pairMs < 100 || pairMs > 90000 || leaseMs < 100 || leaseMs > 120000 || heartbeatMs < 10 || heartbeatMs > 30000 || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 32 || !Number.isSafeInteger(maxProviders) || maxProviders < 1 || maxProviders > 1024) throw fault("A bounded audience, current-authority bridge and durable operation callbacks are required.", 400);
  const tokens = new Map(), connections = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 * 6 + 65536, perMessageDeflate: false });
  let closed = false;
  async function approved(stage, data, transaction) {
    const decision = await authorize({ stage, audience, mode, ...data, ...(transaction ? { transaction } : {}) });
    if (!decision || decision.allowed !== true) throw fault("Current person/session/site/grant or approved provider authority is unavailable.");
    if (decision.binding) { assertProviderBinding(decision.binding); if (decision.binding.audience !== audience) throw fault("Provider audience differs."); }
    return decision;
  }
  function available(connection, readiness = true) {
    if (closed || connections.get(connection.binding.providerId) !== connection || connection.socket.readyState !== WebSocket.OPEN || connection.leaseExpiresAt <= now() || now() - connection.lastHeartbeatAt > heartbeatMs * 3) throw fault("The original provider transport/lease ended; no fallback is permitted.", 409);
    if (readiness && (!connection.ready || !connection.identity)) throw fault("Transport is connected but identity/warehouse/action readiness is not established.", 409);
  }
  function actionAllowed(action, binding) {
    assertProviderAction(action, binding);
    if (mode !== "synthetic" && action.approval.mode !== "live") throw fault("Synthetic qualification cannot dispatch a live upstream request.");
    if (mode === "read_only_dmp" && action.effect !== "read") throw fault("The isolated pilot denies write and print effects, regardless of HTTP method.");
    if (mode === "synthetic" && action.approval.mode !== "synthetic") throw fault("Synthetic transport requires an explicit synthetic contract.");
  }
  async function assertCurrent(stage, actor, connection, details = {}, transaction) {
    available(connection);
    if (!validActor(actor) || actor.siteId !== connection.binding.siteId) throw fault("Requester warehouse differs from original provider.");
    const decision = await approved(stage, { actor, providerId: connection.binding.providerId, binding: clone(connection.binding), identity: clone(connection.identity), identityVerifiedAt: connection.identityVerifiedAt ?? null, ...details }, transaction);
    if (!decision.binding || !same(decision.binding, connection.binding)) throw fault("Original integration/configuration/profile/payload/identity contract pins changed. Reconnect explicitly.", 409);
    available(connection); return decision;
  }
  async function pair({ actor, providerId }) {
    if (closed || !validActor(actor) || actor.grantId) throw fault("A human's current individual browser session must activate pairing.");
    const decision = await approved("pair", { actor, providerId }); const binding = decision.binding;
    if (!binding || binding.providerId !== providerId || !sameOwner(actor, binding) || decision.humanActivated !== true) throw fault("Human activation and the exact owner/provider binding are required.");
    actionAllowed(binding.identity.action, binding);
    if (closed) throw fault("Hub is closed.", 409);
    if (tokens.size >= maxProviders * 2 || connections.size >= maxProviders) throw fault("Provider capacity reached.", 429);
    const token = randomBytes(32).toString("base64url"); tokens.set(hash(token), { binding: clone(binding), expiresAt: now() + pairMs });
    return { token, expiresAt: now() + pairMs, audience, integrationId: binding.integrationId, siteId: binding.siteId };
  }
  async function attach(socket, { token, origin, pathname, audience: reportedAudience, integrationId, siteId, payloadVersionId, payloadHash, profileVersion }) {
    const ticket = tokens.get(hash(token || "")); if (ticket) tokens.delete(hash(token));
    if (!ticket || ticket.expiresAt <= now() || !/^[A-Za-z0-9_-]{43}$/.test(token || "")) throw fault("One-use pairing token is unavailable.");
    const binding = ticket.binding;
    if (origin !== binding.origin || !providerPathMatches(pathname, binding.pagePathPrefix) || reportedAudience !== audience || integrationId !== binding.integrationId || siteId !== binding.siteId || payloadVersionId !== binding.payloadVersionId || payloadHash !== binding.payloadHash || profileVersion !== binding.profileVersion) throw fault("Actual page, integration, warehouse, audience or installed payload differs from pairing.");
    const decision = await approved("attach", { actor: ownerOf(binding), binding, providerId: binding.providerId });
    if (closed || !decision.binding || !same(decision.binding, binding) || connections.has(binding.providerId)) throw fault("Pairing pins changed or this provider already has an original socket.", 409);
    const connection = { binding, nonce: randomUUID(), socket, ready: false, identity: null, challengeId: randomUUID(), leaseExpiresAt: now() + leaseMs, lastHeartbeatAt: now(), pending: new Map(), claiming: false, blockedOperationId: null };
    connections.set(binding.providerId, connection);
    try { await observe({ stage: "attach", binding: clone(binding), connectionNonce: connection.nonce, leaseExpiresAt: connection.leaseExpiresAt }); } catch (error) { await end(connection, "Current provider observation could not be retained."); throw error; }
    connection.identityTimer = setTimeout(() => { if (!connection.ready) void end(connection, "Qualified identity probe timed out.").catch(() => {}); }, binding.identity.action.request.timeoutMs + 1000); connection.identityTimer.unref?.();
    send(socket, { type: "paired", challengeId: connection.challengeId, binding: { ...clone(binding), connectionNonce: connection.nonce } });
    return { providerId: binding.providerId, connectionNonce: connection.nonce, siteId: binding.siteId };
  }
  async function identityResult(connection, message) {
    available(connection, false);
    if (connection.ready || message.challengeId !== connection.challengeId) return false;
    const request = connection.binding.identity.action.request;
    if (message.type !== "identity-result" || !Number.isInteger(message.status) || message.status < 200 || message.status >= 300 || typeof message.body !== "string" || Buffer.byteLength(message.body) > request.maxResponseBytes) throw fault("Qualified identity READ failed; upstream login remains in the human browser.");
    const identity = await verifyIdentity({ status: message.status, body: message.body, contentType: String(message.contentType || "").slice(0, 200) }, connection.binding);
    if (!identity || typeof identity.subject !== "string" || !identity.subject || identity.subject.length > 200 || identity.warehouse !== connection.binding.identity.expectedWarehouse) throw fault("The qualified actual identity/warehouse binding did not match.");
    const decision = await approved("identity", { actor: ownerOf(connection.binding), binding: clone(connection.binding), identity, providerId: connection.binding.providerId });
    if (!decision.binding || !same(decision.binding, connection.binding)) throw fault("Identity contract changed before readiness.", 409);
    if (connection.identity && !same(connection.identity, identity)) throw fault("Actual upstream identity changed. Reconnect explicitly.");
    await observe({ stage: "identity", binding: clone(connection.binding), identity: clone(identity), connectionNonce: connection.nonce, leaseExpiresAt: connection.leaseExpiresAt });
    available(connection, false); connection.identity = clone(identity); connection.identityVerifiedAt = now(); connection.ready = true; clearTimeout(connection.identityTimer);
    send(connection.socket, { type: "ready", identity: clone(identity) }); return true;
  }
  async function renew({ actor, providerId }) {
    const c = connections.get(providerId); if (!c || !sameOwner(actor, c.binding)) throw fault("Only the original human owner can renew this provider lease.");
    available(c, false); const decision = await approved("renew", { actor, binding: clone(c.binding), providerId });
    if (!decision.binding || !same(decision.binding, c.binding)) throw fault("Original provider pins changed.", 409);
    available(c, false); c.leaseExpiresAt = now() + leaseMs;
    await observe({ stage: "renew", binding: clone(c.binding), connectionNonce: c.nonce, leaseExpiresAt: c.leaseExpiresAt });
    // Only the already approved identity read is refreshed in the background.
    // No business operation is enqueued or retried by this heartbeat.
    if (c.ready && !c.pending.size && now() - c.identityVerifiedAt > 30000) { c.ready = false; c.challengeId = randomUUID(); c.identityTimer = setTimeout(() => { if (!c.ready) void end(c, "Identity refresh timed out.").catch(() => {}); }, c.binding.identity.action.request.timeoutMs + 1000); c.identityTimer.unref?.(); send(c.socket, { type: "identity-challenge", challengeId: c.challengeId }); }
    return { expiresAt: c.leaseExpiresAt };
  }
  async function list({ actor }) {
    if (!validActor(actor)) throw fault("Current authenticated individual required."); const visible = [];
    for (const c of connections.values()) try { available(c, false); const decision = await approved("status", { actor, binding: clone(c.binding), providerId: c.binding.providerId }); if (!decision.binding || !same(decision.binding, c.binding) || actor.siteId !== c.binding.siteId) continue; available(c, false); visible.push({ providerId: c.binding.providerId, integrationId: c.binding.integrationId, siteId: c.binding.siteId, owner: clone(c.binding.owner), transport: "connected", authenticated: Boolean(c.identity), actionReady: c.ready && !c.blockedOperationId && decision.actionReady === true, actionReadiness: Array.isArray(decision.actionReadiness) ? decision.actionReadiness.slice(0, 32) : [], identity: clone(c.identity), identityVerifiedAt: c.identityVerifiedAt ?? null, leaseExpiresAt: c.leaseExpiresAt, lastHeartbeatAt: c.lastHeartbeatAt, pending: c.pending.size, blockedReason: c.blockedOperationId ? "An original operation has an uncertain outcome; reconcile it without replay." : null }); } catch { /* Entitled current status only. */ }
    return { connections: visible };
  }
  async function prepare({ actor, providerId, actionVersionId, operationId, input = {} }) {
    const c = connections.get(providerId); if (!c) throw fault("Original provider unavailable.", 404);
    if (typeof operationId !== "string" || !/^[A-Za-z0-9:_-]{16,150}$/.test(operationId) || Buffer.byteLength(JSON.stringify(input)) > 65536) throw fault("A bounded typed input and stable operation ID are required.", 400);
    const decision = await assertCurrent("prepare", actor, c, { actionVersionId, input }); const action = decision.action;
    actionAllowed(action, c.binding); if (action.versionId !== actionVersionId) throw fault("Named immutable action version differs.");
    const immutable = { audience, siteId: c.binding.siteId, integrationId: c.binding.integrationId, providerId, connectionNonce: c.nonce, actor: clone(actor), owner: clone(c.binding.owner), binding: clone(c.binding), action: clone(action), actionVersionId, effect: action.effect, operationId, input: clone(input) };
    const fingerprint = hash(immutable);
    const row = await operations.enqueue({ ...immutable, fingerprint, state: "queued", requestId: null, createdAt: now() }, { limit: maxQueue, recheck: async transaction => { const current = await assertCurrent("enqueue", actor, c, { actionVersionId, input }, transaction); actionAllowed(current.action, c.binding); if (!same(viewOf(current.binding, current.action), viewOf(c.binding, action))) throw fault("Named request/approval changed before durable enqueue.", 409); } });
    if (!row || row.fingerprint !== fingerprint) throw fault("Operation ID already belongs to different pinned work.", 409);
    return publicReceipt(row);
  }
  async function claim({ actor, providerId, operationId, expectedRevision }) {
    const c = connections.get(providerId); if (!c) throw fault("Original provider unavailable.", 404); available(c);
    const row = await operations.get({ siteId: actor.siteId, operationId });
    if (!row || row.providerId !== providerId || row.connectionNonce !== c.nonce || !same(row.actor, actor)) throw fault("Original queued intent does not belong to this actor/provider incarnation.", 404);
    await assertCurrent("claim", actor, c, { actionVersionId: row.actionVersionId, input: row.input, operation: row });
    if (row.state !== "queued") return publicReceipt(row);
    if (row.revision !== expectedRevision) throw fault("The durable operation revision changed.", 409);
    if (c.claiming || c.pending.size || c.blockedOperationId) throw fault("Original provider has in-flight/uncertain work; no reroute or replay is allowed.", 409);
    c.claiming = true;
    try {
      const requestId = randomUUID();
      const claimed = await operations.claim(keyOf(row), { expectedRevision, requestId, connectionNonce: c.nonce, maxInFlight: 1, recheck: async transaction => { const current = await assertCurrent("dispatch", actor, c, { actionVersionId: row.actionVersionId, input: row.input, operation: row }, transaction); actionAllowed(current.action, c.binding); if (!same(viewOf(current.binding, current.action), viewOf(row.binding, row.action))) throw fault("A queued action/profile/payload/request version changed; no hot swap occurred.", 409); } });
      if (!claimed?.claimed) return publicReceipt(claimed?.record ?? row);
      const current = claimed.record; if (current.state !== "dispatching" || current.requestId !== requestId || current.fingerprint !== row.fingerprint) throw fault("Durable claim callback returned an invalid committed intent.", 500);
      try { available(c); } catch { const settled = await operations.settle(keyOf(current), { expectedRevision: current.revision, from: ["dispatching"], state: "not_sent", result: { reason: "Original socket ended before send was attempted." }, at: now() }); return publicReceipt(settled); }
      const job = { row: current, timer: null }; c.pending.set(requestId, job);
      job.timer = setTimeout(() => { void unknown(c, job, "Provider response deadline elapsed.").catch(() => { c.blockedOperationId = current.operationId; }); }, row.action.request.timeoutMs + 1000); job.timer.unref?.();
      try { send(c.socket, { type: "request", requestId, operationId, providerId, connectionNonce: c.nonce, action: clone(row.action) }); }
      catch { await unknown(c, job, "Socket send outcome is uncertain."); }
      return publicReceipt(await operations.get(keyOf(current)));
    } finally { c.claiming = false; }
  }
  async function unknown(c, job, reason) {
    if (c.pending.get(job.row.requestId) !== job) return;
    clearTimeout(job.timer); c.pending.delete(job.row.requestId); c.blockedOperationId = job.row.operationId;
    try { send(c.socket, { type: "cancel", requestId: job.row.requestId, operationId: job.row.operationId }); } catch { /* No automatic reconnect/retry. */ }
    return operations.settle(keyOf(job.row), { expectedRevision: job.row.revision, from: ["dispatching"], state: "unknown", result: { reason }, at: now() });
  }
  async function result({ providerId, connectionNonce, siteId }, message) {
    if (!message || typeof message.operationId !== "string" || !/^[A-Za-z0-9:_-]{16,150}$/.test(message.operationId) || typeof message.requestId !== "string" || message.requestId.length > 200 || ![true, false].includes(message.ok)) return { accepted: false };
    const c = connections.get(providerId), row = await operations.get({ siteId: siteId ?? c?.binding.siteId, operationId: message.operationId });
    if (!row || row.providerId !== providerId || row.connectionNonce !== connectionNonce || row.requestId !== message.requestId) return { accepted: false };
    const response = message.ok === true ? { ok: true, status: message.status, body: message.body, contentType: String(message.contentType || "").slice(0, 200), effectOutcome: "unverified" } : { ok: false, reason: String(message.error || "Provider failed.").slice(0, 500), disposition: message.disposition };
    const job = c?.nonce === connectionNonce ? c.pending.get(message.requestId) : null;
    if (message.ok === true && (!Number.isInteger(message.status) || message.status < 100 || message.status > 599 || typeof message.body !== "string" || Buffer.byteLength(message.body) > row.action.request.maxResponseBytes)) { if (job && row.state === "dispatching") await unknown(c, job, "Invalid bounded provider response; the upstream outcome is uncertain."); return { accepted: false }; }
    if (!job || row.state !== "dispatching") { const evidence = { type: "late_result", requestId: message.requestId, at: now(), response }; const retained = await operations.appendEvidence(keyOf(row), evidence, { limit: 4, dedupeKey: hash({ requestId: message.requestId, response }) }); return { accepted: false, retainedLateEvidence: retained === true }; }
    if (message.ok === true && !same(message.identity, c.identity)) { await unknown(c, job, "Actual upstream identity changed while the request was in flight."); return { accepted: false }; }
    clearTimeout(job.timer); c.pending.delete(message.requestId);
    if (message.ok === true) c.identityVerifiedAt = now();
    const state = message.ok === true ? "reported" : "unknown";
    if (state === "unknown") c.blockedOperationId = row.operationId;
    const settled = await operations.settle(keyOf(row), { expectedRevision: row.revision, from: ["dispatching"], state, result: response, at: now() }); return { accepted: true, receipt: publicReceipt(settled) };
  }
  async function cancel({ actor, providerId, operationId }) {
    const c = connections.get(providerId); if (!c) throw fault("Original provider unavailable; inspect the durable receipt.", 409);
    const row = await operations.get({ siteId: actor.siteId, operationId }); if (!row || row.providerId !== providerId || !same(row.actor, actor)) throw fault("Original operation is unavailable.", 404);
    await assertCurrent("cancel", actor, c, { operation: row, actionVersionId: row.actionVersionId, input: row.input });
    if (row.state === "queued") return publicReceipt(await operations.settle(keyOf(row), { expectedRevision: row.revision, from: ["queued"], state: "cancelled", result: { reason: "Cancelled before dispatch." }, at: now() }));
    const job = c.pending.get(row.requestId); if (row.state === "dispatching" && job) await unknown(c, job, "Requester cancelled after durable dispatch; upstream outcome is uncertain.");
    return publicReceipt(await operations.get(keyOf(row)));
  }
  async function end(c, reason) {
    if (connections.get(c.binding.providerId) === c) connections.delete(c.binding.providerId);
    c.ready = false; clearTimeout(c.identityTimer);
    for (const job of [...c.pending.values()]) await unknown(c, job, reason);
    try { await observe({ stage: "end", binding: clone(c.binding), connectionNonce: c.nonce, reason }); } finally { c.socket.close(1000, "Original provider ended"); }
  }
  async function disconnect({ actor, providerId }) { const c = connections.get(providerId); if (!c || !sameOwner(actor, c.binding)) throw fault("Only the original owner can disconnect this provider."); await approved("disconnect", { actor, providerId, binding: clone(c.binding) }); await end(c, "Original provider disconnected after dispatch."); return { disconnected: true }; }
  async function revoke({ actor, providerId }) { const decision = await approved("revoke", { actor, providerId }); for (const [id, ticket] of tokens) if (ticket.binding.providerId === providerId) tokens.delete(id); const c = connections.get(providerId); if (c) await end(c, "Current provider authority was revoked after dispatch."); return { revoked: decision.allowed === true }; }
  function handleUpgrade(req, socket, head) {
    socket.on("error", () => {});
    if (closed || req.url !== "/api/integration-relay/ws" || ![...tokens.values()].some(t => t.expiresAt > now() && t.binding.origin === req.headers.origin) || wss.clients.size >= maxProviders) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      let attached = null, serial = Promise.resolve(); const originalConnection = () => { const c = attached && connections.get(attached.providerId); return c?.nonce === attached?.connectionNonce ? c : null; }; const timer = setTimeout(() => ws.close(1008, "Pairing timed out"), 5000); timer.unref?.();
      ws.on("error", () => {}); ws.on("pong", () => { const c = attached && connections.get(attached.providerId); if (c?.nonce === attached.connectionNonce) c.lastHeartbeatAt = now(); });
      ws.on("message", (raw, binary) => { serial = serial.then(async () => { if (binary) throw fault("JSON frames required."); const message = JSON.parse(raw.toString()); if (!attached) { if (message.type !== "pair") throw fault("Pairing required."); attached = await attach(ws, { ...message, origin: req.headers.origin }); clearTimeout(timer); return; } const c = originalConnection(); if (message.type === "identity-result" || message.type === "identity-failed") { if (c) await identityResult(c, message); } else if (message.type === "heartbeat") { if (!c) throw fault("Original provider ended."); await renew({ actor: ownerOf(c.binding), providerId: c.binding.providerId }); } else if (message.type === "result") await result(attached, { ...message, siteId: c?.binding.siteId }); else throw fault("Unknown provider frame."); }).catch(async () => { const c = originalConnection(); if (c) await end(c, "Provider protocol/identity failed after dispatch."); else ws.close(1008, "Invalid pairing"); }); });
      ws.on("close", () => { clearTimeout(timer); void serial.finally(() => { const c = attached && connections.get(attached.providerId); if (c?.nonce === attached.connectionNonce) return end(c, "Original provider socket closed after dispatch."); }).catch(() => {}); });
    });
  }
  const timer = setInterval(() => { for (const [id, ticket] of tokens) if (ticket.expiresAt <= now()) tokens.delete(id); for (const c of connections.values()) { if (c.leaseExpiresAt <= now() || now() - c.lastHeartbeatAt > heartbeatMs * 3) void end(c, "Original provider heartbeat/lease expired after dispatch.").catch(() => {}); else c.socket.ping(); } }, heartbeatMs); timer.unref();
  async function close() { closed = true; clearInterval(timer); tokens.clear(); for (const c of [...connections.values()]) await end(c, "Hub stopped after durable dispatch; no replay occurred."); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); }
  return { pair, attach, renew, list, disconnect, prepare, claim, result, cancel, revoke, handleUpgrade, close };
}
