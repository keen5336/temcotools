const fail = message => { throw new Error(message); };
const bytes = value => new TextEncoder().encode(value).byteLength;
const scalar = value => typeof value === "string" && value.length > 0 && value.length <= 200;
export function assertProviderOrigin(origin) {
  const value = new URL(origin);
  if (value.protocol !== "https:" || value.origin !== origin || value.username || value.password || /[*\s]/.test(origin)) fail("An exact HTTPS origin is required.");
  return origin;
}
export function assertProviderPath(value) {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.startsWith("//") || /[\\#*\s\u0000-\u001f\u007f]/.test(value)) fail("A bounded same-origin path is required.");
  for (const part of value.split("?", 1)[0].split("/")) {
    const decoded = decodeURIComponent(part);
    if ([".", ".."].includes(decoded) || /[\\/%?#\u0000-\u001f\u007f]/.test(decoded)) fail("Path encoding cannot change routing.");
  }
  return value;
}
export function providerPathMatches(pathname, prefix) {
  assertProviderPath(pathname); assertProviderPath(prefix);
  if (pathname.includes("?") || prefix.includes("?")) fail("Only pathname may be reported.");
  const base = prefix === "/" ? "/" : prefix.replace(/\/$/, "");
  return base === "/" || pathname === base || pathname.startsWith(`${base}/`);
}
export function assertMappedProviderRequest(request, origin) {
  if (!request || Object.keys(request).some(key => !["origin", "path", "method", "body", "contentType", "timeoutMs", "maxResponseBytes"].includes(key))) fail("Only server-mapped request fields are supported; custom headers are prohibited.");
  assertProviderOrigin(origin); assertProviderPath(request.path);
  if (request.origin !== origin || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method) || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 60000 || !Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes < 1 || request.maxResponseBytes > 4 * 1024 * 1024) fail("Invalid bounded mapped request.");
  if (request.body !== undefined && (typeof request.body !== "string" || bytes(request.body) > 65536 || ["GET", "HEAD"].includes(request.method))) fail("Invalid mapped request body.");
  if ((request.body !== undefined || request.contentType !== undefined) && !["application/json", "application/x-www-form-urlencoded"].includes(request.contentType)) fail("Unsupported request content type.");
  if (new URL(request.path, origin).origin !== origin) fail("Requests cannot change origin.");
  return request;
}
export function assertProviderBinding(binding) {
  if (JSON.stringify(binding).length > 131072) fail("Provider binding exceeds its bounded metadata limit.");
  const allowed = ["providerId", "audience", "siteId", "integrationId", "owner", "configurationVersion", "profileVersion", "adapterVersion", "payloadVersionId", "payloadHash", "origin", "pagePathPrefix", "actionVersionIds", "identity", "connectionNonce"];
  if (!binding || Object.keys(binding).some(key => !allowed.includes(key)) || !binding.owner || Object.keys(binding.owner).some(key => !["userId", "sessionId", "deviceId", "tabId", "authVersion"].includes(key)) || !Number.isSafeInteger(binding.owner.authVersion) || binding.owner.authVersion < 1) fail("Only explicit non-secret provider binding fields are supported.");
  if (!binding || ![binding.providerId, binding.audience, binding.siteId, binding.integrationId, binding.owner?.userId, binding.owner?.sessionId, binding.owner?.deviceId, binding.owner?.tabId, binding.configurationVersion, binding.profileVersion, binding.adapterVersion, binding.payloadVersionId].every(scalar) || !/^[a-f0-9]{64}$/.test(binding.payloadHash || "")) fail("Complete immutable provider binding is required.");
  assertProviderOrigin(binding.origin); if (!providerPathMatches(binding.pagePathPrefix, binding.pagePathPrefix)) fail("Invalid page prefix.");
  if (!Array.isArray(binding.actionVersionIds) || binding.actionVersionIds.length < 1 || binding.actionVersionIds.length > 32 || !binding.actionVersionIds.every(scalar) || new Set(binding.actionVersionIds).size !== binding.actionVersionIds.length) fail("Pin bounded named action versions.");
  const identity = binding.identity;
  if (!identity || Object.keys(identity).some(key => !["action", "format", "subjectPath", "warehousePath", "expectedWarehouse", "contractId", "warehouseContractId"].includes(key)) || !scalar(identity.contractId) || !scalar(identity.warehouseContractId) || !scalar(identity.expectedWarehouse) || !identity.action || identity.action.effect !== "read" || !binding.actionVersionIds.includes(identity.action.versionId)) fail("An approved named identity READ and warehouse binding are required.");
  assertProviderAction(identity.action, binding);
  return binding;
}
export function assertProviderAction(action, binding) {
  if (!action || Object.keys(action).some(key => !["versionId", "key", "effect", "approval", "request"].includes(key)) || !action.approval || Object.keys(action.approval).some(key => !["id", "mode", "evidenceReference", "requestContractHash"].includes(key)) || !scalar(action.versionId) || !scalar(action.key) || !["read", "write", "print"].includes(action.effect) || !binding.actionVersionIds.includes(action.versionId) || !scalar(action.approval?.id) || !["live", "synthetic"].includes(action.approval?.mode) || (typeof action.approval?.evidenceReference !== "string" || action.approval.evidenceReference.length < 5 || action.approval.evidenceReference.length > 1000) || !/^[a-f0-9]{64}$/.test(action.approval?.requestContractHash || "")) fail("A server-approved immutable named action is required.");
  assertMappedProviderRequest(action.request, binding.origin);
  return action;
}
function select(body, path) {
  if (!Array.isArray(path) || path.length < 1 || path.length > 6 || path.some(key => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key))) fail("A bounded identity field path is required.");
  let value = body;
  for (const key of path) value = value && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined;
  if (!scalar(value)) fail("Identity/warehouse is not present in the qualified response.");
  return value;
}
/** JSON is the built-in bounded parser. A reviewed XML/site parser must be supplied as trusted adapter code, never eval or a client expression. */
export function readProviderIdentity(result, contract) {
  if (result.status < 200 || result.status >= 300 || contract.format !== "json") fail("This identity contract/parser is unavailable or upstream sign-in ended.");
  const value = JSON.parse(result.body);
  return { subject: select(value, contract.subjectPath), warehouse: select(value, contract.warehousePath) };
}
/** No camera, DOM capture, login, pairing approval, token storage or automatic WebSocket reconnect is performed here. */
export function createBrowserProviderExecutor({ expected, send, fetch: fetchImpl = globalThis.fetch.bind(globalThis), location = globalThis.location, parseIdentity = readProviderIdentity, onStatus = () => {}, clock = () => performance.now() }) {
  if (!expected || typeof send !== "function" || !location) fail("An approved payload binding, page and explicit socket sender are required.");
  assertProviderOrigin(expected.origin);
  let binding, identity, stopped = false, ready = false, active = null, generation = 0;
  const seen = new Set(), controllers = new Set();
  const same = (a, b) => a && b && a.subject === b.subject && a.warehouse === b.warehouse;
  function actualPage() { if (location.origin !== expected.origin || !providerPathMatches(location.pathname, expected.pagePathPrefix)) fail("This actual page is outside the approved origin/path. No operational work was sent."); }
  actualPage();
  function checkBinding(value) {
    assertProviderBinding(value); actualPage();
    for (const key of ["audience", "integrationId", "origin", "pagePathPrefix", "profileVersion", "adapterVersion", "configurationVersion", "payloadVersionId", "payloadHash"]) if (expected[key] !== value[key]) fail("The installed payload/profile version does not match this pairing.");
    if (expected.siteId && expected.siteId !== value.siteId) fail("Pairing belongs to another warehouse.");
  }
  async function perform(request, signal) {
    actualPage(); assertMappedProviderRequest(request, binding.origin);
    const response = await fetchImpl(new URL(request.path, binding.origin).href, { method: request.method, ...(request.body === undefined ? {} : { body: request.body }), headers: request.contentType ? { "Content-Type": request.contentType } : {}, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal });
    if (Number(response.headers.get("content-length")) > request.maxResponseBytes) { await response.body?.cancel(); fail("Body exceeds the approved response limit."); }
    const reader = response.body?.getReader(), decoder = new TextDecoder(); let body = "", count = 0;
    if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength; if (count > request.maxResponseBytes) { await reader.cancel(); fail("Body exceeds the approved response limit."); } body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); } finally { reader.releaseLock(); }
    return { status: response.status, contentType: (response.headers.get("content-type") || "").slice(0, 200), body };
  }
  async function identify(signal) { const result = await perform(binding.identity.action.request, signal); const observed = await parseIdentity(result, binding.identity); if (!same(observed, { subject: observed.subject, warehouse: binding.identity.expectedWarehouse })) fail("Actual upstream warehouse differs from the approved binding."); if (identity && !same(identity, observed)) fail("Actual upstream identity or warehouse changed; reconnect explicitly."); return { result, observed }; }
  function report(message) { if (!stopped) send(message); }
  async function handle(message) {
    if (stopped) return;
    if (message.type === "paired") {
      if (binding) fail("An established executor cannot hot-swap its pairing.");
      checkBinding(message.binding); binding = structuredClone(message.binding);
      const controller = new AbortController(); controllers.add(controller); const timer = setTimeout(() => controller.abort(), binding.identity.action.request.timeoutMs);
      try { const { result, observed } = await identify(controller.signal); identity = observed; report({ type: "identity-result", challengeId: message.challengeId, ...result }); onStatus({ transport: "connected", authentication: "checking", ready: false }); }
      catch { report({ type: "identity-failed", challengeId: message.challengeId }); onStatus({ transport: "connected", authentication: "unavailable", ready: false }); }
      finally { clearTimeout(timer); controllers.delete(controller); }
      return;
    }
    if (message.type === "ready") { actualPage(); if (!binding || !same(identity, message.identity)) fail("Server/browser identity verification differs."); ready = true; onStatus({ transport: "connected", authentication: "verified", ready: true }); return; }
    if (message.type === "cancel") { if (active?.requestId === message.requestId && active.operationId === message.operationId) active.controller.abort(); return; }
    if (message.type !== "request" || !binding || !identity || !ready) return;
    if (seen.has(message.requestId)) return;
    if (active || seen.size >= 256) { report({ type: "result", requestId: message.requestId, operationId: message.operationId, ok: false, disposition: "not_sent", error: "Executor is busy or its bounded session history is full; reconnect explicitly." }); return; }
    seen.add(message.requestId); const controller = new AbortController(), version = generation; active = { requestId: message.requestId, operationId: message.operationId, controller }; controllers.add(controller);
    const started = clock(); let sent = false; const timer = setTimeout(() => controller.abort(), message.action?.request?.timeoutMs || 1000);
    try {
      actualPage(); assertProviderAction(message.action, binding);
      if (!scalar(message.requestId) || !scalar(message.operationId) || message.providerId !== binding.providerId || message.connectionNonce !== binding.connectionNonce) fail("Request correlation or original provider changed.");
      const before = await identify(controller.signal); controller.signal.throwIfAborted(); if (!same(before.observed, identity) || version !== generation) fail("Identity changed before dispatch.");
      sent = true; const result = await perform(message.action.request, controller.signal);
      const after = await identify(controller.signal); controller.signal.throwIfAborted(); if (!same(after.observed, identity) || version !== generation) fail("Identity changed while request was in flight.");
      report({ type: "result", requestId: message.requestId, operationId: message.operationId, ok: true, identity, ...result, elapsedMs: Math.max(0, clock() - started) });
    } catch { if (version === generation) report({ type: "result", requestId: message.requestId, operationId: message.operationId, ok: false, disposition: sent ? "unknown" : "not_sent", error: sent ? "Upstream outcome is uncertain. No replay occurred." : "The page, identity, request or bounded executor was not ready. No business request was sent." }); }
    finally { clearTimeout(timer); controllers.delete(controller); if (active?.requestId === message.requestId) active = null; }
  }
  function stop() { stopped = true; ready = false; generation++; for (const controller of controllers) controller.abort(); controllers.clear(); active = null; onStatus({ transport: "disconnected", authentication: "unknown", ready: false }); }
  return { handle, stop, busy: () => active !== null };
}
