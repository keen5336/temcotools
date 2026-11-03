import assert from "node:assert/strict";
import test from "node:test";
import { boundedIntegrationPath, exactIntegrationOrigin, integrationActionHash, integrationPathMatches, mapActionRequest, validateActionInputs, validateActionOutput, validateIntegrationAction, type IntegrationActionDefinition, type IntegrationEffect } from "../lib/integrations/definition";
import { canReadOperationReceipt, canViewProvider, chooseProviderRoute, decidePrinterClaim, decideProviderDispatch, type DispatchContext, type DispatchDecision, type OperationReceipt, type PrinterQueueJob, type ProviderRecord, type StoredActionPublication, type StoredActionVersion, type StoredContractApproval, type StoredDeviceLink, type StoredProviderGrant, type StoredProviderRoute } from "../lib/integrations/provider-policy";

const now = Date.parse("2026-11-03T12:00:00Z"), origin = "https://synthetic-integration.example.invalid";
const input = { day: "2026-11-03", item: "UNIT 0001", count: 2, selectedIds: ["R1", "R2"] };
function definition(effect: IntegrationEffect = "read", method: IntegrationActionDefinition["request"]["method"] = "POST") {
  return validateIntegrationAction({ integrationId: "synthetic-wms", key: "delivery.items", name: "Synthetic delivery items", adapterId: "approved-http", adapterVersion: 1, origin, pagePathPrefix: "/portal", effect, requiredCapability: effect === "read" ? "workflow.read" : effect === "print" ? "labels.print" : "workflow.execute",
    inputs: { day: { type: "string", maxLength: 10 }, item: { type: "string", maxLength: 50 }, count: { type: "integer", min: 1, max: 10 }, selectedIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 20 } } }, output: { type: "object", fields: { count: { type: "integer", min: 0 } } },
    request: { method, path: "/api/items/{item}", query: { day: { from: "input", path: ["day"] }, site: { from: "warehouse" } }, ...(!["GET", "HEAD"].includes(method) ? { body: { encoding: "form", fields: { ids: { from: "input", path: ["selectedIds"], format: "csv" }, command: { from: "constant", value: "SYNTHETIC_READ" }, quantity: { from: "input", path: ["count"] } } } } : {}) },
    limits: { timeoutMs: 10_000, maxInputBytes: 8192, maxResponseBytes: 1_048_576, maxConcurrent: 2, maxQueued: 4, heartbeatMaxAgeMs: 20_000, identityMaxAgeMs: 60_000 } });
}
async function fixture(effect: IntegrationEffect = "read", method: IntegrationActionDefinition["request"]["method"] = "POST") {
  const def = definition(effect, method);
  const version: StoredActionVersion = { id: "version-1", integrationId: def.integrationId, actionKey: def.key, revision: 1, enabled: true, definition: def };
  const publication: StoredActionPublication = { id: "publication-1", actionVersionId: version.id, definitionHash: await integrationActionHash(def), contractApprovalId: "contract-1", siteId: "site-a", state: "published", publishedAt: now - 1000 };
  const approval: StoredContractApproval = { id: "contract-1", state: "approved", reviewedByPlatformAdminId: "synthetic-platform-admin", reviewedAt: now - 1000, mode: "live", evidenceReference: "synthetic-fixture-reference-only", integrationId: def.integrationId, actionKey: def.key, adapterId: def.adapterId, adapterVersion: def.adapterVersion, origin, pagePathPrefix: "/portal", requestPathPrefix: "/api/items", method, effect, requiredCapability: def.requiredCapability, identityContractId: "identity-v1", warehouseBindingContractId: "warehouse-v1" };
  const provider: ProviderRecord = { id: "provider-a", siteId: "site-a", integrationId: def.integrationId, kind: effect === "print" ? "printer" : "browser", ownerUserId: "person-a", ownerSessionId: "owner-session", ownerDeviceId: "laptop-a", ownerTabId: "upstream-tab", configVersion: 2, adapterId: def.adapterId, adapterVersion: 1, profileVersion: 4, payloadVersion: "payload-v7", revokedAt: null, leaseExpiresAt: now + 300_000, lastHeartbeatAt: now - 100, transport: "connected", lastError: null, page: { origin, pathname: "/portal/day", independentlyVerifiedAt: now - 100 }, identity: { subject: "SYNTHETIC_UPSTREAM_USER", contractId: "identity-v1", verifiedAt: now - 100 }, warehouseBinding: { siteId: "site-a", upstreamWarehouse: "SYNTHETIC_DEPOT", contractId: "warehouse-v1", verifiedAt: now - 100 }, actionReadiness: { [def.key]: { state: "ready" } }, ...(effect === "print" ? { physicalPrinterId: "physical-printer-a" } : {}) };
  const context: DispatchContext = { now, actor: { userId: "person-a", siteId: "site-a", sessionId: "owner-session", deviceId: "laptop-a", tabId: "upstream-tab", userActive: true, membershipActive: true, siteActive: true, sessionActive: true, capabilities: [def.requiredCapability], groupIds: [] }, providerOwner: { userId: "person-a", siteId: "site-a", sessionId: "owner-session", userActive: true, membershipActive: true, sessionActive: true, allowedActionKeys: [def.key] }, pins: { actionVersionId: version.id, publicationId: publication.id, contractApprovalId: approval.id, providerId: provider.id, providerConfigVersion: 2, adapterVersion: 1, profileVersion: 4, payloadVersion: "payload-v7" }, mode: "pilot-read-only", operationId: "operation-1", grants: [], inFlight: 0, queued: 0 };
  return { def, version, publication, approval, provider, context, run: () => decideProviderDispatch(version, publication, approval, provider, input, context) };
}
function code(decision: DispatchDecision) { return decision.kind === "blocked" ? decision.code : decision.kind; }
function grant(context: DispatchContext, changes: Partial<StoredProviderGrant> = {}): StoredProviderGrant {
  return { id: "share-1", providerId: context.pins.providerId, siteId: context.actor.siteId, grantee: { kind: "user", userId: context.actor.userId, sessionId: context.actor.sessionId }, createdByUserId: "person-a", issuerSessionId: "owner-session", createdAt: now - 500, expiresAt: now + 60_000, revokedAt: null, actionKeys: ["delivery.items"], effects: ["read"], viewStatus: true, ...changes };
}

test("typed mappings preserve raw values, encode route/query inputs and constrain response shapes", () => {
  const def = definition(), request = mapActionRequest(def, input, "SYNTHETIC_DEPOT");
  assert.equal(request.origin, origin); assert.equal(request.path, "/api/items/UNIT%200001?day=2026-11-03&site=SYNTHETIC_DEPOT");
  assert.equal(request.body, "ids=R1%2CR2&command=SYNTHETIC_READ&quantity=2"); assert.equal(request.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(validateActionInputs(def, input), input); assert.deepEqual(validateActionOutput(def, { count: 2 }), { count: 2 });
  for (const bad of [{ ...input, count: "2" }, { ...input, extra: true }, { ...input, selectedIds: ["A,B"] }]) assert.throws(() => mapActionRequest(def, bad, "SYNTHETIC_DEPOT"));
  assert.throws(() => validateActionOutput(def, { count: -1 })); assert.throws(() => validateActionOutput(def, { count: 1, unexpected: "hidden" }));
});
test("origins, paths, credentials, prototypes and unbounded JSON fail closed", () => {
  assert.equal(exactIntegrationOrigin(origin), origin); assert.equal(boundedIntegrationPath("/portal/My%20day"), "/portal/My%20day");
  for (const bad of [origin + "/", "https://*.example.invalid", "https://person:secret@example.invalid", "http://example.invalid"]) assert.throws(() => exactIntegrationOrigin(bad));
  for (const bad of ["//elsewhere", "/api/../items", "/api/%2e%2e/items", "/api%2Fitems", "/api%252Fitems", "/api?token=x", "/api#x", "/api\\items"]) assert.throws(() => boundedIntegrationPath(bad));
  assert.equal(integrationPathMatches("/portal/day", "/portal"), true); assert.equal(integrationPathMatches("/portals", "/portal"), false);
  const def = definition();
  for (const item of ["../OTHER", "/other", "A%2fB", "A?else", "A#other", ".."]) assert.throws(() => mapActionRequest(def, { ...input, item }, "SYNTHETIC_DEPOT"));
  assert.throws(() => validateIntegrationAction({ ...def, request: { ...def.request, headers: { Cookie: "never allowed" } } }));
  assert.throws(() => validateIntegrationAction({ ...def, inputs: { password: { type: "string" } } }));
  assert.throws(() => validateActionInputs(def, JSON.parse('{"__proto__":{"admin":true}}')));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; assert.throws(() => validateActionInputs(def, cyclic));
  const accessor = Object.defineProperty({}, "item", { enumerable: true, get: () => { throw new Error("must not evaluate"); } }); assert.throws(() => validateActionInputs(def, accessor), /accessors/);
  assert.throws(() => validateActionInputs(def, { ...input, selectedIds: new Array(2) }), /dense/);
  assert.throws(() => validateIntegrationAction({ ...def, request: { ...def.request, method: "GET" } }), /body/);
});
test("canonical content hashes are independent of object insertion order but change with request semantics", async () => {
  const def = definition();
  assert.equal(await integrationActionHash(def), await integrationActionHash({ ...def, inputs: Object.fromEntries(Object.entries(def.inputs).reverse()) }));
  assert.notEqual(await integrationActionHash(def), await integrationActionHash({ ...def, request: { ...def.request, path: "/api/other/{item}" } }));
});
test("a qualified semantic read POST can enqueue, while GET write and printer effects stay denied in pilot", async () => {
  const read = await fixture(); const result = await read.run(); assert.equal(result.kind, "ready");
  if (result.kind === "ready") { assert.equal(result.execution, "enqueue"); assert.equal(result.effect, "read"); assert.equal(result.request.method, "POST"); }
  for (const [effect, method] of [["write", "GET"], ["print", "POST"]] as const) assert.equal(code(await (await fixture(effect, method)).run()), "pilot-effect-disabled");
});
test("draft claims cannot qualify live actions; separate approved evidence/hash/publication is mandatory", async () => {
  const f = await fixture(); f.approval.mode = "synthetic"; assert.equal(code(await f.run()), "contract-unqualified");
  f.approval.mode = "live"; f.approval.evidenceReference = null; assert.equal(code(await f.run()), "contract-evidence");
  f.approval.evidenceReference = "synthetic-only-test"; f.approval.effect = "write"; assert.equal(code(await f.run()), "contract-approval");
  f.approval.effect = "read"; f.publication.state = "disabled"; assert.equal(code(await f.run()), "publication-unavailable");
  f.publication.state = "published"; f.version.definition = { ...f.def, name: "Changed after publication" }; assert.equal(code(await f.run()), "publication-hash");
});
test("warehouse, current authority and immutable queued pins are checked separately", async () => {
  const mutations: Array<[(f: Awaited<ReturnType<typeof fixture>>) => void, string]> = [
    [f => { f.context.actor.siteId = "site-b"; }, "site-mismatch"],
    [f => { f.context.actor.membershipActive = false; }, "actor-authority"],
    [f => { f.context.actor.capabilities = []; }, "action-capability"],
    [f => { f.context.providerOwner.sessionActive = false; }, "provider-owner-authority"],
    [f => { f.context.providerOwner.allowedActionKeys = []; }, "provider-owner-action"],
    [f => { f.context.pins.payloadVersion = "old-version"; }, "version-pins"],
    [f => { f.context.pins.providerConfigVersion = 1; }, "version-pins"],
    [f => { f.provider.integrationId = "different-system"; }, "integration-mismatch"],
    [f => { f.context.run = { id: "run-a", stepId: "step-a", siteId: "site-b", definitionVersionId: "workflow-v1" }; }, "run-site"],
  ];
  for (const [mutate, expected] of mutations) { const f = await fixture(); mutate(f); assert.equal(code(await f.run()), expected); }
});
test("same-user login on another tab/session/device or MCP client does not inherit provider authority", async () => {
  for (const mutation of [
    (c: DispatchContext) => { c.actor.tabId = "other-tab"; },
    (c: DispatchContext) => { c.actor.sessionId = "other-session"; },
    (c: DispatchContext) => { c.actor.deviceId = "zebra-a"; },
    (c: DispatchContext) => { c.actor.oauthGrantId = "mcp-a"; c.actor.oauthGrantActive = true; },
  ]) { const f = await fixture(); mutation(f.context); assert.equal(code(await f.run()), "provider-grant"); }
  const f = await fixture(); f.context.actor.sessionId = "other-session"; f.context.actor.oauthGrantId = "mcp-a"; f.context.actor.oauthGrantActive = true;
  f.context.grants = [grant(f.context, { grantee: { kind: "user", userId: "person-a" } })]; assert.equal(code(await f.run()), "provider-grant");
  f.context.grants = [grant(f.context, { grantee: { kind: "user", userId: "person-a", oauthGrantId: "mcp-a" } })];
  const allowed = await f.run(); assert.equal(allowed.kind, "ready"); if (allowed.kind === "ready") { assert.equal(allowed.actorGrantId, "mcp-a"); assert.equal(allowed.providerOwnerSessionId, "owner-session"); assert.equal(allowed.grantId, "share-1"); }
});
test("cross-user/group shares remain site, named-action, effect, issuing-session and expiry scoped", async () => {
  const f = await fixture(); f.context.actor.userId = "person-b"; f.context.actor.sessionId = "person-b-session";
  f.context.grants = [grant(f.context)]; assert.equal(code(await f.run()), "ready");
  for (const change of [{ siteId: "site-b" }, { actionKeys: ["unrelated.action"] }, { effects: ["write"] }, { expiresAt: now }, { revokedAt: now - 1 }, { issuerSessionId: "old-owner-session" }, { createdByUserId: "person-b" }]) {
    f.context.grants = [grant(f.context, change as Partial<StoredProviderGrant>)]; assert.equal(code(await f.run()), "provider-grant");
  }
  f.context.actor.groupIds = ["floor-team-a"]; f.context.grants = [grant(f.context, { grantee: { kind: "group", groupId: "floor-team-a" } })]; assert.equal(code(await f.run()), "ready");
  f.context.actor.groupIds = []; assert.equal(code(await f.run()), "provider-grant");
});
test("device links never grant actions alone and revoked links invalidate their routed grants", async () => {
  const f = await fixture(); f.context.actor.deviceId = "zebra-a";
  const link: StoredDeviceLink = { id: "link-a", userId: "person-a", siteId: "site-a", devices: ["laptop-a", "zebra-a"], approvedByUserId: "person-a", approvedAt: now - 1000, expiresAt: now + 100_000, revokedAt: null };
  f.context.deviceLinks = [link]; assert.equal(code(await f.run()), "provider-grant");
  f.context.grants = [grant(f.context, { deviceLinkId: link.id, grantee: { kind: "user", userId: "person-a", deviceId: "zebra-a" } })]; assert.equal(code(await f.run()), "ready");
  link.revokedAt = now; assert.equal(code(await f.run()), "provider-grant");
});
test("connected transport is not authenticated, warehouse-bound or action-ready", async () => {
  const mutations: Array<[(f: Awaited<ReturnType<typeof fixture>>) => void, string]> = [
    [f => { f.provider.transport = "disconnected"; }, "provider-disconnected"],
    [f => { f.provider.lastHeartbeatAt = now - 21_000; }, "provider-disconnected"],
    [f => { f.provider.leaseExpiresAt = now; }, "provider-lease"],
    [f => { f.provider.identity = null; }, "upstream-authentication"],
    [f => { f.provider.identity!.verifiedAt = now - 61_000; }, "upstream-authentication"],
    [f => { f.provider.warehouseBinding!.siteId = "site-b"; }, "warehouse-binding"],
    [f => { f.provider.page!.origin = "https://other-system.example.invalid"; }, "actual-page"],
    [f => { f.provider.page!.pathname = "/portal-other/day"; }, "actual-page"],
    [f => { f.provider.actionReadiness[f.def.key] = { state: "unknown", reason: "Actual identity contract is pending." }; }, "action-not-ready"],
    [f => { f.approval.requestPathPrefix = "/api/other"; }, "request-path"],
  ];
  for (const [mutate, expected] of mutations) { const f = await fixture(); mutate(f); assert.equal(code(await f.run()), expected); }
});
test("retries return original receipts; unknown/dispatched outcomes never replay; queued claim uses current pins and CAS", async () => {
  const f = await fixture(), prepared = await f.run(); assert.equal(prepared.kind, "ready"); if (prepared.kind !== "ready") return;
  const receipt: OperationReceipt = { id: "receipt-a", operationId: f.context.operationId, actorUserId: f.context.actor.userId, siteId: f.context.actor.siteId, providerId: f.provider.id, actionVersionId: f.version.id, requestHash: prepared.requestHash, revision: 1, state: "unknown" };
  f.context.operation = receipt;
  for (const state of ["unknown", "dispatching", "succeeded", "failed", "queued"] as const) { receipt.state = state; const retry = await f.run(); assert.equal(retry.kind, "existing"); if (retry.kind === "existing") assert.equal(retry.mayRedispatch, false); }
  f.context.phase = "claim"; f.context.expectedOperationRevision = 0; assert.equal(code(await f.run()), "operation-revision");
  f.context.expectedOperationRevision = 1; const claim = await f.run(); assert.equal(claim.kind, "ready"); if (claim.kind === "ready") assert.equal(claim.execution, "dispatch");
  receipt.state = "unknown"; assert.equal(code(await f.run()), "existing"); receipt.state = "queued"; receipt.requestHash = "different"; assert.equal(code(await f.run()), "operation-reuse");
  f.context.operation = undefined; assert.equal(code(await f.run()), "operation-missing");
});
test("a queued claim rechecks a revoked share, changed provider version and expired lease", async () => {
  const f = await fixture(); f.context.actor.sessionId = "receiving-session"; f.context.grants = [grant(f.context)];
  const prepared = await f.run(); assert.equal(prepared.kind, "ready"); if (prepared.kind !== "ready") return;
  f.context.operation = { id: "receipt-a", operationId: f.context.operationId, actorUserId: f.context.actor.userId, siteId: f.context.actor.siteId, providerId: f.provider.id, actionVersionId: f.version.id, requestHash: prepared.requestHash, revision: 1, state: "queued" };
  f.context.phase = "claim"; f.context.expectedOperationRevision = 1;
  f.context.grants[0].revokedAt = now; assert.equal(code(await f.run()), "provider-grant");
  f.context.grants[0].revokedAt = null; f.provider.configVersion++; assert.equal(code(await f.run()), "version-pins");
  f.provider.configVersion--; f.provider.leaseExpiresAt = now; assert.equal(code(await f.run()), "provider-lease");
  assert.equal(f.context.operation.state, "queued", "A denied claim never advances or resubmits the original receipt.");
});
test("receipt reads remain possible offline but require current ownership, warehouse and view capability", async () => {
  const f = await fixture(), p = await f.run(); assert.equal(p.kind, "ready"); if (p.kind !== "ready") return;
  const receipt: OperationReceipt = { id: "r", operationId: "o", actorUserId: "person-a", siteId: "site-a", providerId: f.provider.id, actionVersionId: f.version.id, requestHash: p.requestHash, revision: 1, state: "unknown" };
  f.provider.transport = "disconnected"; assert.equal(canReadOperationReceipt(receipt, f.context.actor, "workflow.read", now), true);
  assert.equal(canReadOperationReceipt(receipt, { ...f.context.actor, userId: "person-b" }, "workflow.read", now), false);
  assert.equal(canReadOperationReceipt(receipt, { ...f.context.actor, membershipActive: false }, "workflow.read", now), false);
});
test("bounded provider queue separates enqueue from dispatch and synthetic execution cannot become live", async () => {
  const f = await fixture(); f.context.inFlight = 2; assert.equal(code(await f.run()), "ready");
  f.context.queued = 4; assert.equal(code(await f.run()), "provider-backpressure");
  f.context.queued = 0; f.context.mode = "dry-run"; assert.equal(code(await f.run()), "provider-mode");
  f.provider.kind = "synthetic"; f.provider.transport = "disconnected"; f.provider.identity = null; f.provider.warehouseBinding = null; f.approval.mode = "synthetic";
  const simulated = await f.run(); assert.equal(simulated.kind, "ready"); if (simulated.kind === "ready") assert.equal(simulated.execution, "simulate");
  f.context.mode = "live"; assert.equal(code(await f.run()), "contract-unqualified");
});
test("status visibility is own-user/site or explicitly shared, without granting execution", async () => {
  const f = await fixture(); f.context.actor.tabId = "other-tab";
  assert.equal(canViewProvider(f.provider, f.context.actor, [], now), true); assert.equal(code(await f.run()), "provider-grant");
  f.context.actor.userId = "person-b"; f.context.actor.sessionId = "other-session";
  const share = grant(f.context); assert.equal(canViewProvider(f.provider, f.context.actor, [share], now), false);
  assert.equal(canViewProvider(f.provider, f.context.actor, [share], now, [], f.context.providerOwner), true);
  assert.equal(canViewProvider(f.provider, { ...f.context.actor, siteId: "site-b" }, [share], now, [], f.context.providerOwner), false);
});
test("explicit device defaults cannot silently fail over or pick ambiguous providers", async () => {
  const f = await fixture(); const route: StoredProviderRoute = { id: "route-a", userId: "person-a", siteId: "site-a", deviceId: "laptop-a", integrationId: f.def.integrationId, purpose: "read", providerId: f.provider.id, revision: 1, enabled: true };
  const query = { integrationId: f.def.integrationId, purpose: "read" as const, expectedRouteRevision: 1 };
  assert.deepEqual(chooseProviderRoute([route], [f.provider], f.context.actor, query, now), { kind: "selected", providerId: f.provider.id, routeId: route.id });
  f.provider.transport = "disconnected"; assert.equal(chooseProviderRoute([route], [f.provider, { ...f.provider, id: "other-live", transport: "connected" }], f.context.actor, query, now).kind, "blocked");
  f.provider.transport = "connected"; assert.equal(chooseProviderRoute([route, { ...route, id: "ambiguous" }], [f.provider], f.context.actor, query, now).kind, "blocked");
  assert.equal(chooseProviderRoute([route], [f.provider], f.context.actor, { ...query, expectedRouteRevision: 2 }, now).kind, "blocked");
});
test("physical printer queue keeps requester/run attribution, separates print rights and never replays an uncertain or ACKed job", async () => {
  const f = await fixture("print"); f.context.mode = "live"; f.context.run = { id: "run-a", stepId: "labels", siteId: "site-a", definitionVersionId: "workflow-v1" }; const prepared = await f.run(); assert.equal(prepared.kind, "ready"); if (prepared.kind !== "ready") return;
  f.context.operation = { id: "print-op", operationId: f.context.operationId, actorUserId: "person-a", siteId: "site-a", providerId: f.provider.id, actionVersionId: f.version.id, requestHash: prepared.requestHash, revision: 1, state: "queued" }; f.context.phase = "claim"; f.context.expectedOperationRevision = 1;
  const authority = await f.run(); assert.equal(authority.kind, "ready");
  const job: PrinterQueueJob = { id: "job-a", siteId: "site-a", physicalPrinterId: "physical-printer-a", providerId: f.provider.id, requesterUserId: "person-a", runId: "run-a", stepId: "labels", operationId: f.context.operationId, position: 2, revision: 1, state: "queued" };
  const request = { jobId: job.id, siteId: job.siteId, requesterUserId: job.requesterUserId, physicalPrinterId: job.physicalPrinterId, providerId: job.providerId, expectedRevision: 1 };
  assert.equal(decidePrinterClaim([job], request, prepared).kind, "blocked", "Preparing is not permission to send.");
  const claimed = decidePrinterClaim([job], request, authority); assert.equal(claimed.kind, "claim"); if (claimed.kind === "claim") { assert.equal(claimed.runId, "run-a"); assert.equal(claimed.requesterUserId, "person-a"); assert.equal(claimed.physicalPrintConfirmed, false); }
  const other: PrinterQueueJob = { ...job, id: "other-private-job", siteId: "site-b", requesterUserId: "person-b", state: "unknown" };
  const blocked = decidePrinterClaim([job, other], request, authority); assert.equal(blocked.kind, "blocked"); assert.equal(JSON.stringify(blocked).includes(other.id), false);
  for (const state of ["dispatching", "unknown", "acknowledged", "physically-confirmed"] as const) { job.state = state; const previous = decidePrinterClaim([job], request, authority); assert.equal(previous.kind, "existing"); if (previous.kind === "existing") assert.equal(previous.physicalPrintConfirmed, state === "physically-confirmed"); }
});
