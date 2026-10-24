// Served as a classic script by the Next loader route. Keep every dependency
// explicit in that route: no build-time bundle or DMP-specific operation here.
export function startDmpRelay(config) {
  if (!config.allowedOrigins.includes(location.origin)) { alert("This page is not a configured DMP site."); return; }
  window.__temcoApiRelay?.stop();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const panel = host.attachShadow({ mode: "open" });
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;color:#17202a;border:1px solid #888;border-radius:8px;padding:14px;box-shadow:0 3px 20px #0003;font:14px system-ui;max-width:300px";
  const title = document.createElement("strong"); title.textContent = "Temco DMP API Relay";
  const status = document.createElement("p"); status.textContent = "Connect this DMP tab to your Temco account.";
  status.setAttribute("role", "status");
  const connectButton = document.createElement("button"); connectButton.textContent = "Connect";
  const stopButton = document.createElement("button"); stopButton.textContent = "Disconnect";
  box.append(title, status, connectButton, document.createTextNode(" "), stopButton); panel.append(box); document.body.append(host);
  const active = new Map();
  const controllers = new Set();
  let stopped = false, socket, popup, nonce, subject, identity, subjectPath, identityPromise, checkTimer;
  let generation = 0;
  const say = (message) => { status.textContent = message; };
  const reply = (message) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  function stop() {
    if (stopped) return;
    stopped = true;
    generation++;
    clearInterval(checkTimer);
    for (const controller of controllers) controller.abort();
    active.clear();
    socket?.close(); popup?.close();
    window.removeEventListener("message", onPair);
    window.removeEventListener("pagehide", stop);
    host.remove();
    if (window.__temcoApiRelay?.stop === stop) delete window.__temcoApiRelay;
  }
  function fail(message) {
    say(message);
    for (const controller of controllers) controller.abort();
    clearInterval(checkTimer);
    socket?.close();
    connectButton.disabled = false;
  }
  async function perform(request, controller) {
    const descriptor = validateRequest(request);
    const url = new URL(descriptor.path, location.origin);
    if (url.origin !== location.origin) throw new Error("DMP requests must stay on this site.");
    const response = await fetch(url.href, { method: descriptor.method, headers: descriptor.headers, body: descriptor.body, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal });
    if (Number(response.headers.get("content-length")) > config.maxResponseBytes) { await response.body?.cancel(); throw new Error("DMP response is too large."); }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let body = "", bytes = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > config.maxResponseBytes) { await reader.cancel(); throw new Error("DMP response is too large."); }
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    return { status: response.status, contentType: response.headers.get("content-type") || "", body };
  }
  function identify() {
    if (identityPromise) return identityPromise;
    const version = generation;
    identityPromise = (async () => {
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), identity.timeoutMs);
      try {
        const result = await perform(identity, controller);
        if (result.status < 200 || result.status >= 300) throw new Error("DMP session ended.");
        const current = subjectFromBody(result.body, subjectPath);
        if (subject !== undefined && current !== subject) throw new Error("DMP account changed.");
        return current;
      } catch {
        if (version === generation) {
          reply({ type: "identity-changed" });
          fail("DMP account changed or signed out. Connect again after signing in.");
        }
        throw new Error("DMP account changed or signed out.");
      } finally { clearTimeout(timer); controllers.delete(controller); }
    })().finally(() => { if (version === generation) identityPromise = undefined; });
    return identityPromise;
  }
  async function onRequest(message) {
    const version = generation;
    if (!subject || active.has(message.requestId)) return;
    if (active.size >= config.maxConcurrent) { reply({ type: "result", requestId: message.requestId, ok: false, error: "DMP relay is busy." }); return; }
    const controller = new AbortController();
    active.set(message.requestId, controller); controllers.add(controller);
    let timer;
    try {
      const request = validateRequest(message.request);
      timer = setTimeout(() => controller.abort(), request.timeoutMs);
      await identify(); controller.signal.throwIfAborted();
      if (version !== generation) return;
      const result = await perform(request, controller);
      // Avoid returning a response from a different account if DMP changed
      // sessions while the API request was in flight.
      await identify(); controller.signal.throwIfAborted();
      if (version === generation) reply({ type: "result", requestId: message.requestId, ok: true, subject, ...result });
    } catch (error) {
      if (version === generation) reply({ type: "result", requestId: message.requestId, ok: false, error: error.name === "AbortError" ? "DMP request cancelled or timed out; it was not retried." : error.message });
    } finally { clearTimeout(timer); active.delete(message.requestId); controllers.delete(controller); }
  }
  function onPair(event) {
    if (stopped || event.origin !== config.temcoOrigin || event.source !== popup || event.data?.type !== "temco-api-relay-pair" || event.data.nonce !== nonce || typeof event.data.token !== "string") return;
    const token = event.data.token;
    nonce = undefined; popup?.close();
    generation++;
    identityPromise = undefined;
    try { socket = new WebSocket(config.wsUrl); }
    catch { fail("DMP blocked the Temco WebSocket connection. Check the page’s connection policy."); return; }
    const current = socket;
    socket.onopen = () => { if (socket === current) current.send(JSON.stringify({ type: "pair", token })); };
    socket.onmessage = async (event) => {
      if (socket !== current || stopped) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "paired") {
          identity = message.identity; subjectPath = message.subjectPath; subject = undefined;
          const version = generation;
          const user = await identify();
          if (version !== generation) return;
          subject = user;
          reply({ type: "identity", subject });
        } else if (message.type === "ready") {
          say(`Connected as DMP user ${subject}. Keep this tab open.`);
          checkTimer = setInterval(() => { void identify().catch(() => {}); }, 15000);
        } else if (message.type === "request") { void onRequest(message); }
        else if (message.type === "cancel") active.get(message.requestId)?.abort();
      } catch { if (socket === current) fail("DMP relay could not initialize. Connect again."); }
    };
    socket.onerror = () => { if (socket === current) fail("Cannot reach Temco API relay. Check your connection and the DMP page permissions."); };
    socket.onclose = () => { if (socket === current) fail("Disconnected. Connect again to pair this tab; requests are never replayed."); };
    say("Checking DMP session…");
  }
  connectButton.onclick = () => {
    if (socket && socket.readyState < WebSocket.CLOSING) return;
    nonce = crypto.randomUUID();
    const url = new URL("/tools/api-relay/pair", config.temcoOrigin);
    url.searchParams.set("origin", location.origin); url.searchParams.set("nonce", nonce);
    popup = window.open(url.href, "_blank", "popup,width=560,height=650");
    if (!popup) { say("Allow this pairing popup, then press Connect again."); return; }
    connectButton.disabled = true; say("Confirm your account in the Temco pairing window.");
    const poll = setInterval(() => { if (stopped || popup?.closed) { clearInterval(poll); if (!socket || socket.readyState >= WebSocket.CLOSING) connectButton.disabled = false; } }, 1000);
  };
  stopButton.onclick = stop;
  window.addEventListener("message", onPair);
  window.addEventListener("pagehide", stop);
  window.__temcoApiRelay = { stop };
}
