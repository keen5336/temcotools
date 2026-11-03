/** Classic-script payload UI. Dependencies are concatenated by the trusted builtin builder. */
export function startGenericProvider(config, payload) {
  const profile = payload?.profileBinding;
  if (!profile || payload.purpose !== "integration_relay" || location.origin !== profile.origin || !providerPathMatches(location.pathname, profile.pathPrefix)) { alert("This approved provider payload needs its current Connect Temco site mapping. No work was sent."); return; }
  if (window.__temcoGenericProvider?.busy?.() || window.__temcoApiRelay?.busy?.()) { alert("Temco work is still in flight. Keep its original adapter until its result is known."); return; }
  window.__temcoGenericProvider?.stop();
  const host = document.createElement("div"); host.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:min(320px,94vw)";
  const shadow = host.attachShadow({ mode: "open" }), box = document.createElement("div"); box.style.cssText = "padding:14px;background:white;color:#17202a;border:1px solid #888;border-radius:8px;font:14px system-ui;box-shadow:0 3px 20px #0003";
  const title = document.createElement("strong"); title.textContent = "Connect TemcoTools";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Connect this signed-in page using an approved warehouse provider. Credentials stay here.";
  const connect = document.createElement("button"), disconnect = document.createElement("button"); connect.textContent = "Connect this tab"; disconnect.textContent = "Disconnect";
  for (const button of [connect, disconnect]) button.style.cssText = "min-height:44px;padding:8px;margin:3px";
  box.append(title, status, connect, disconnect); shadow.append(box); document.body.append(host);
  let stopped = false, popup, nonce, socket, executor, heartbeat, popupPoll;
  const say = value => { status.textContent = value; };
  const reference = { payloadId: payload.payloadId, versionId: payload.versionId, contentHash: payload.contentHash, profileBinding: profile };
  function end(message) { clearInterval(heartbeat); heartbeat = undefined; executor?.stop(); executor = undefined; socket?.close(); socket = undefined; connect.disabled = false; if (!stopped) say(message); }
  function stop() { if (stopped) return; stopped = true; clearInterval(popupPoll); clearInterval(heartbeat); executor?.stop(); socket?.close(); popup?.close(); window.removeEventListener("message", receive); window.removeEventListener("pagehide", stop); host.remove(); if (window.__temcoGenericProvider?.stop === stop) delete window.__temcoGenericProvider; }
  function actual() { if (location.origin !== profile.origin || !providerPathMatches(location.pathname, profile.pathPrefix)) throw new Error("Actual page moved outside the approved origin/path. Reconnect on the supported page."); }
  async function receive(event) {
    if (stopped || event.origin !== config.temcoOrigin || event.source !== popup || event.data?.type !== "temco-provider-pair" || event.data.nonce !== nonce) return;
    try {
      actual();
      const { binding, token } = event.data;
      assertProviderBinding(binding);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token || "") || binding.origin !== profile.origin || binding.pagePathPrefix !== profile.pathPrefix || binding.profileVersion !== `${profile.profileId}:${profile.revision}` || binding.payloadVersionId !== payload.versionId || binding.payloadHash !== payload.contentHash) throw new Error("Pairing differs from this installed page/profile/payload. No work was sent.");
      nonce = undefined; popup?.close(); clearInterval(popupPoll);
      const current = new WebSocket(config.wsUrl); socket = current;
      const expected = { ...binding };
      executor = createBrowserProviderExecutor({ expected, send: value => { if (socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify(value)); }, location, onStatus: value => { if (value.ready) say(`Connected · ${binding.integrationId} · warehouse ${binding.siteId}. Named approved actions only.`); else say(`Transport ${value.transport}; authentication ${value.authentication}. No action readiness is assumed.`); } });
      current.onopen = () => { if (socket !== current || stopped) return; current.send(JSON.stringify({ type: "pair", token, pathname: location.pathname, audience: binding.audience, integrationId: binding.integrationId, siteId: binding.siteId, payloadVersionId: payload.versionId, payloadHash: payload.contentHash, profileVersion: binding.profileVersion })); heartbeat = setInterval(() => { if (socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: "heartbeat" })); }, 15000); };
      current.onmessage = event => { if (socket !== current || stopped) return; try { void executor?.handle(JSON.parse(event.data)).catch(() => end("Provider validation failed. Reconnect explicitly; original work was not replayed.")); } catch { end("Invalid relay message. Original work was not replayed."); } };
      current.onclose = () => { if (socket === current) end("Disconnected or lease ended. Reconnect this original tab; no request was replayed or rerouted."); };
      current.onerror = () => { if (socket === current) end("The approved relay could not connect. Check page CSP/network; no bypass or replay was attempted."); };
      say("Connecting; actual upstream identity and warehouse still need verification.");
    } catch (error) { end(error instanceof Error ? error.message : "Pairing failed closed."); }
  }
  connect.onclick = () => {
    try {
      actual(); if (executor?.busy()) throw new Error("Original work is still running. Wait for its result.");
      nonce = crypto.randomUUID();
      const url = new URL("/tools/provider-connect", config.temcoOrigin); url.searchParams.set("nonce", nonce); url.searchParams.set("origin", location.origin); url.searchParams.set("pathname", location.pathname); url.searchParams.set("payload", JSON.stringify(reference));
      popup = window.open(url.href, "_blank", "popup,width=560,height=700");
      if (!popup) { say("Allow this pairing popup, then press Connect again."); return; }
      connect.disabled = true; say("Choose the exact approved provider in the Temco window, then confirm connection as yourself.");
      clearInterval(popupPoll); popupPoll = setInterval(() => { if (stopped || popup?.closed) { clearInterval(popupPoll); if (!socket) { connect.disabled = false; say("Pairing window closed. Connect again when ready."); } } }, 1000);
    } catch (error) { say(error instanceof Error ? error.message : "Page is unavailable."); }
  };
  disconnect.onclick = () => { if (executor?.busy() && !confirm("Work may already have reached the external system. Disconnect without replaying it?")) return; stop(); };
  window.addEventListener("message", receive); window.addEventListener("pagehide", stop);
  window.__temcoGenericProvider = { stop, busy: () => executor?.busy() || false };
}
