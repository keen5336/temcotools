// Persist only newly generated command/intent IDs, never operation selectors or
// inputs. A failed inspection of A must never replace a later selector for B.
const newIntentActions = new Set([
  "integrations.draft.save", "integrations.publish", "integrations.qualify", "integrations.rollback", "integrations.enabled",
  "connections.register", "connections.grant", "connections.grant.revoke", "connections.device.link", "connections.device.unlink", "connections.device.default", "connections.runtime.configure", "connections.operation.prepare",
]);
const commandActions = new Set(["connections.operation.reconcile", "connections.operation.cancel-queued"]);
export async function connectionCommand<T>(action: string, input: unknown): Promise<T> {
  let body = input, receiptKey: string | null = null;
  const generatedKey = newIntentActions.has(action) ? "operationId" : commandActions.has(action) ? "commandId" : null;
  if (generatedKey && input && typeof input === "object" && generatedKey in input) {
    const fields = { ...input as Record<string, unknown> }; delete fields[generatedKey];
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([window.__temcoUiContextV1?.context, window.__temcoUiContextV1?.siteId, action, fields])));
    receiptKey = "temco-connection-command:" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const prior = sessionStorage.getItem(receiptKey), commandId = prior || String((input as Record<string, unknown>)[generatedKey]);
    if (!prior && Object.keys(sessionStorage).filter(k => k.startsWith("temco-connection-command:")).length >= 100) throw new Error("Review pending connection command receipts before creating more work.");
    sessionStorage.setItem(receiptKey, commandId); body = { ...fields, [generatedKey]: commandId };
  }
  const response = await fetch(`/api/application/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not complete action. Any new command ID is retained; existing operation selectors are unchanged.");
  if (receiptKey) sessionStorage.removeItem(receiptKey); return data.result;
}
