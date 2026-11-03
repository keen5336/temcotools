import {
  type IntegrationActionDefinition, type IntegrationEffect, type JsonValue, type MappedActionRequest,
  boundedIntegrationPath, exactIntegrationOrigin, integrationActionHash, integrationContentHash,
  integrationPathMatches, mapActionRequest, validateActionInputs, validateIntegrationAction,
} from "./definition";

/** Every Stored* value is an authoritative server-loaded row, not an action/tool input. */
export interface StoredActionVersion { id: string; integrationId: string; actionKey: string; revision: number; enabled: boolean; definition: unknown }
/** Separate protected persistence, never a claim supplied with a tool's inputs. */
export interface StoredContractApproval {
  id: string; state: "approved" | "revoked"; reviewedByPlatformAdminId: string; reviewedAt: number;
  mode: "unqualified" | "synthetic" | "live"; evidenceReference: string | null;
  integrationId: string; actionKey: string; adapterId: string; adapterVersion: number;
  origin: string; pagePathPrefix: string; requestPathPrefix: string;
  method: IntegrationActionDefinition["request"]["method"]; effect: IntegrationEffect; requiredCapability: string;
  identityContractId: string; warehouseBindingContractId: string;
}
export interface StoredActionPublication {
  id: string; actionVersionId: string; definitionHash: string; contractApprovalId: string;
  siteId: string | null; state: "published" | "disabled" | "revoked"; publishedAt: number;
}
export interface ProviderRecord {
  id: string; siteId: string; integrationId: string; kind: "browser" | "printer" | "synthetic";
  ownerUserId: string; ownerSessionId: string; ownerDeviceId: string; ownerTabId: string;
  configVersion: number; adapterId: string; adapterVersion: number; profileVersion: number; payloadVersion: string;
  revokedAt: number | null; leaseExpiresAt: number; lastHeartbeatAt: number;
  transport: "connected" | "disconnected"; lastError: { code: string; reconnectRequired: boolean } | null;
  page: { origin: string; pathname: string; independentlyVerifiedAt: number } | null;
  identity: { subject: string; contractId: string; verifiedAt: number } | null;
  warehouseBinding: { siteId: string; upstreamWarehouse: string; contractId: string; verifiedAt: number } | null;
  actionReadiness: Record<string, { state: "ready" | "blocked" | "unknown"; reason?: string }>;
  physicalPrinterId?: string;
}
export interface CurrentActorAuthority {
  userId: string; siteId: string; sessionId: string; deviceId?: string; tabId?: string; oauthGrantId?: string;
  oauthGrantActive?: boolean;
  userActive: boolean; membershipActive: boolean; siteActive: boolean; sessionActive: boolean;
  capabilities: readonly string[]; groupIds: readonly string[];
}
export interface CurrentProviderOwnerAuthority { userId: string; siteId: string; sessionId: string; userActive: boolean; membershipActive: boolean; sessionActive: boolean; allowedActionKeys: readonly string[] }
export interface StoredDeviceLink {
  id: string; userId: string; siteId: string; devices: readonly [string, string];
  approvedByUserId: string; approvedAt: number; expiresAt: number; revokedAt: number | null;
}
export type ProviderGrantee = { kind: "user"; userId: string; sessionId?: string; deviceId?: string; oauthGrantId?: string } | { kind: "group"; groupId: string };
export interface StoredProviderGrant {
  id: string; providerId: string; siteId: string; grantee: ProviderGrantee;
  createdByUserId: string; issuerSessionId: string; createdAt: number; expiresAt: number; revokedAt: number | null;
  actionKeys: readonly string[]; effects: readonly IntegrationEffect[]; viewStatus: boolean; deviceLinkId?: string;
}
export interface ActionPins {
  actionVersionId: string; publicationId: string; contractApprovalId: string;
  providerId: string; providerConfigVersion: number; adapterVersion: number; profileVersion: number; payloadVersion: string;
}
export interface OperationReceipt {
  id: string; operationId: string; actorUserId: string; siteId: string; providerId: string;
  actionVersionId: string; requestHash: string; revision: number;
  state: "queued" | "dispatching" | "succeeded" | "failed" | "unknown";
}
export interface DispatchContext {
  now: number; actor: CurrentActorAuthority; providerOwner: CurrentProviderOwnerAuthority;
  pins: ActionPins; mode: "dry-run" | "pilot-read-only" | "live";
  operationId: string; phase?: "prepare" | "claim"; expectedOperationRevision?: number;
  grants: readonly StoredProviderGrant[]; deviceLinks?: readonly StoredDeviceLink[];
  operation?: OperationReceipt;
  inFlight: number; queued: number;
  run?: { id: string; stepId: string; siteId: string; definitionVersionId: string };
}
export type PolicyBlock = { kind: "blocked"; severity: "red" | "yellow"; code: string; reason: string; fix: string };
export type DispatchDecision = PolicyBlock
  | { kind: "existing"; receiptId: string; state: OperationReceipt["state"]; mayRedispatch: false }
  | { kind: "ready"; effect: IntegrationEffect; execution: "simulate" | "enqueue" | "dispatch"; phase: "prepare" | "claim"; actorUserId: string; actorSessionId: string; actorGrantId: string | null; providerOwnerUserId: string; providerOwnerSessionId: string; providerOwnerDeviceId: string; providerOwnerTabId: string; physicalPrinterId: string | null; siteId: string; grantId: string | null; pins: ActionPins; operationId: string; requestHash: string; request: MappedActionRequest; input: Record<string, JsonValue>; run: DispatchContext["run"] | null };
const block = (code: string, reason: string, fix: string, severity: PolicyBlock["severity"] = "red"): PolicyBlock => ({ kind: "blocked", severity, code, reason, fix });
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const fresh = (value: number, now: number, maxAge: number) => validTime(value) && value <= now && now - value <= maxAge;
const liveWindow = (start: number, end: number, revoked: number | null, now: number) => validTime(start) && validTime(end) && start <= now && end > now && end > start && revoked === null;

function actorFailure(actor: CurrentActorAuthority, now: number): PolicyBlock | null {
  if (!validTime(now) || !actor.userId || !actor.siteId || !actor.sessionId || !actor.userActive || !actor.membershipActive || !actor.siteActive || !actor.sessionActive || (actor.oauthGrantId && actor.oauthGrantActive !== true)) return block("actor-authority", "The current person, warehouse membership, client grant or issuing session is not active.", "Sign in or ask the warehouse administrator to restore the specific membership.");
  return null;
}
function ownerFailure(provider: ProviderRecord, owner: CurrentProviderOwnerAuthority): PolicyBlock | null {
  if (owner.userId !== provider.ownerUserId || owner.siteId !== provider.siteId || owner.sessionId !== provider.ownerSessionId || !owner.userActive || !owner.membershipActive || !owner.sessionActive) return block("provider-owner-authority", "The original provider owner's session or warehouse authority is no longer active.", "The provider owner must reconnect under their current warehouse membership.");
  return null;
}
function granteeMatches(grantee: ProviderGrantee, actor: CurrentActorAuthority): boolean {
  if (grantee.kind === "group") return actor.groupIds.includes(grantee.groupId);
  if (!grantee.sessionId && !grantee.deviceId && !grantee.oauthGrantId) return false;
  return grantee.userId === actor.userId && (!grantee.sessionId || grantee.sessionId === actor.sessionId) && (!grantee.deviceId || grantee.deviceId === actor.deviceId) && (!grantee.oauthGrantId || grantee.oauthGrantId === actor.oauthGrantId);
}
function usableGrant(grant: StoredProviderGrant, provider: ProviderRecord, actor: CurrentActorAuthority, now: number, links: readonly StoredDeviceLink[]) {
  if (grant.providerId !== provider.id || grant.siteId !== provider.siteId || grant.siteId !== actor.siteId || grant.createdByUserId !== provider.ownerUserId || grant.issuerSessionId !== provider.ownerSessionId || !liveWindow(grant.createdAt, grant.expiresAt, grant.revokedAt, now) || !granteeMatches(grant.grantee, actor)) return false;
  if (grant.deviceLinkId) {
    const link = links.find(link => link.id === grant.deviceLinkId);
    if (!link || provider.ownerUserId !== actor.userId || link.userId !== actor.userId || link.siteId !== actor.siteId || link.approvedByUserId !== actor.userId || !liveWindow(link.approvedAt, link.expiresAt, link.revokedAt, now) || !actor.deviceId || !link.devices.includes(actor.deviceId) || !link.devices.includes(provider.ownerDeviceId) || actor.deviceId === provider.ownerDeviceId) return false;
  }
  return true;
}
function owningDocument(provider: ProviderRecord, actor: CurrentActorAuthority) {
  // A cookie on another tab, another device, or a same-user OAuth client is not this document.
  return !actor.oauthGrantId && actor.userId === provider.ownerUserId && actor.sessionId === provider.ownerSessionId && actor.deviceId === provider.ownerDeviceId && actor.tabId === provider.ownerTabId;
}

/** Status visibility is deliberately broader than dispatch authority, never estate-wide. Expired providers remain visible with red status. */
export function canViewProvider(provider: ProviderRecord, actor: CurrentActorAuthority, grants: readonly StoredProviderGrant[], now: number, links: readonly StoredDeviceLink[] = [], owner?: CurrentProviderOwnerAuthority): boolean {
  if (actorFailure(actor, now) || actor.siteId !== provider.siteId) return false;
  return actor.userId === provider.ownerUserId || Boolean(owner && !ownerFailure(provider, owner) && actor.capabilities.includes(provider.kind === "printer" ? "labels.read" : "workflow.read") && grants.some(grant => grant.viewStatus && grant.actionKeys.some(key => owner.allowedActionKeys.includes(key)) && usableGrant(grant, provider, actor, now, links)));
}

/** Receipt ownership is not dependent on a provider being online. The view capability comes from server policy. */
export function canReadOperationReceipt(receipt: OperationReceipt, actor: CurrentActorAuthority, viewCapability: string, now: number): boolean {
  return !actorFailure(actor, now) && receipt.actorUserId === actor.userId && receipt.siteId === actor.siteId && actor.capabilities.includes(viewCapability);
}

/** No network, page login, grant creation or effect occurs here. Call with fresh server-loaded records inside the dispatch writer. */
export async function decideProviderDispatch(
  version: StoredActionVersion, publication: StoredActionPublication, approval: StoredContractApproval,
  provider: ProviderRecord, input: unknown, context: DispatchContext,
): Promise<DispatchDecision> {
  const { actor, now, pins } = context;
  const inactive = actorFailure(actor, now); if (inactive) return inactive;
  if (context.run && (context.run.siteId !== actor.siteId || !context.run.id || !context.run.stepId || !context.run.definitionVersionId)) return block("run-site", "The originating run/step is not pinned to this warehouse.", "Resume the original run in its warehouse; a UI site switch cannot move it.");
  if (actor.siteId !== provider.siteId || (publication.siteId !== null && publication.siteId !== actor.siteId)) return block("site-mismatch", "The action or provider belongs to another warehouse.", "Choose a provider explicitly authorized for this run's warehouse.");
  if (!version.enabled || publication.state !== "published" || !fresh(publication.publishedAt, now, Number.MAX_SAFE_INTEGER) || publication.actionVersionId !== version.id || publication.contractApprovalId !== approval.id) return block("publication-unavailable", "This published action version is disabled, revoked or unavailable.", "Select an available published version; never replace an in-flight intent.");
  let definition: IntegrationActionDefinition, values: Record<string, JsonValue>, request: MappedActionRequest;
  try {
    definition = validateIntegrationAction(version.definition);
    if (await integrationActionHash(definition) !== publication.definitionHash) return block("publication-hash", "The immutable definition no longer matches its publication.", "Restore the published version; do not dispatch changed source.");
    values = validateActionInputs(definition, input);
    request = mapActionRequest(definition, values, provider.warehouseBinding?.upstreamWarehouse ?? "");
  } catch { return block("definition-input-invalid", "The action definition or supplied typed inputs are invalid.", "Review the selected version and its input contract; no work was dispatched."); }
  if (version.integrationId !== definition.integrationId || version.actionKey !== definition.key || provider.integrationId !== definition.integrationId) return block("integration-mismatch", "This action and provider are different integrations.", "Choose the exact integration provider; a DMP grant cannot authorize another system.");
  if (approval.state !== "approved" || !approval.reviewedByPlatformAdminId || !fresh(approval.reviewedAt, now, Number.MAX_SAFE_INTEGER) || approval.integrationId !== definition.integrationId || approval.actionKey !== definition.key || approval.adapterId !== definition.adapterId || approval.adapterVersion !== definition.adapterVersion || approval.effect !== definition.effect || approval.method !== definition.request.method || approval.requiredCapability !== definition.requiredCapability || approval.origin !== definition.origin || approval.pagePathPrefix !== definition.pagePathPrefix) return block("contract-approval", "The platform-approved contract does not cover this action version.", "Obtain a reviewed contract for this origin, adapter, method and semantic effect.");
  try {
    exactIntegrationOrigin(approval.origin); boundedIntegrationPath(approval.requestPathPrefix);
    if (!integrationPathMatches(request.path.split("?", 1)[0], approval.requestPathPrefix)) return block("request-path", "The mapped request is outside its approved endpoint prefix.", "Correct the bounded action mapping and publish a reviewed version.");
  } catch { return block("request-path", "The approved origin/path or mapped endpoint is invalid.", "Review the contract without widening its origins or paths."); }
  if (!actor.capabilities.includes(definition.requiredCapability)) return block("action-capability", "The current person/client no longer has this action's capability.", "Use a currently authorized account/client scope.");
  if (context.mode !== "dry-run" && approval.mode !== "live") return block("contract-unqualified", "This contract is synthetic or not qualified for live execution.", "Use the dry-run workflow or provide the exact private upstream contract evidence.");
  if (approval.mode === "live" && (!approval.evidenceReference || !approval.identityContractId || !approval.warehouseBindingContractId)) return block("contract-evidence", "Live identity, warehouse or action evidence is missing.", "Qualify the actual integration contract; HTTP method alone is not evidence of safety.");
  if (context.mode === "pilot-read-only" && definition.effect !== "read") return block("pilot-effect-disabled", "This pilot permits qualified reads only; write and print effects are disabled.", "Use a synthetic workflow; live effects need separate authority and qualification.");
  if (context.mode === "dry-run" ? provider.kind !== "synthetic" : provider.kind === "synthetic") return block("provider-mode", "A synthetic provider cannot dispatch live work, or vice versa.", "Select the explicit synthetic provider for dry-run work.");
  if (definition.effect === "print" && context.mode !== "dry-run" && (provider.kind !== "printer" || !provider.physicalPrinterId)) return block("printer-provider", "Printing requires a specifically registered physical-printer provider.", "Select the approved printer and its separate print grant.");
  const ownerInactive = ownerFailure(provider, context.providerOwner); if (ownerInactive) return ownerInactive;
  if (!context.providerOwner.allowedActionKeys.includes(definition.key)) return block("provider-owner-action", "The provider owner no longer has authority to provide this named action.", "Recheck the owner's current warehouse permissions before sharing or dispatch.");
  const grant = owningDocument(provider, actor) ? null : context.grants.find(grant => usableGrant(grant, provider, actor, now, context.deviceLinks ?? []) && grant.actionKeys.includes(definition.key) && grant.effects.includes(definition.effect));
  if (!owningDocument(provider, actor) && !grant) return block("provider-grant", "This session/device/client has no current named-action grant from the provider owner.", "The human provider owner must explicitly share the required actions and effect type; same-account login is insufficient.");
  if (pins.actionVersionId !== version.id || pins.publicationId !== publication.id || pins.contractApprovalId !== approval.id || pins.providerId !== provider.id || pins.providerConfigVersion !== provider.configVersion || pins.adapterVersion !== provider.adapterVersion || pins.profileVersion !== provider.profileVersion || pins.payloadVersion !== provider.payloadVersion || definition.adapterId !== provider.adapterId || definition.adapterVersion !== provider.adapterVersion) return block("version-pins", "A pinned action, configuration, adapter, profile or payload version changed.", "Reconcile the queued intent; do not hot-swap a published version or provider.");
  if (provider.revokedAt !== null || !validTime(provider.leaseExpiresAt) || provider.leaseExpiresAt <= now) return block("provider-lease", "The selected provider was revoked or its lease expired.", "Its human owner must reconnect; the requester cannot renew or borrow another session.");
  if (context.mode !== "dry-run") {
    if (provider.transport !== "connected" || !fresh(provider.lastHeartbeatAt, now, definition.limits.heartbeatMaxAgeMs) || provider.lastError?.reconnectRequired) return block("provider-disconnected", "The selected provider is disconnected, stale or requires reconnect.", "Reconnect that provider; writes never silently reroute.");
    if (!provider.identity?.subject || provider.identity.contractId !== approval.identityContractId || !fresh(provider.identity.verifiedAt, now, definition.limits.identityMaxAgeMs)) return block("upstream-authentication", "Transport is connected but actual upstream identity is missing or stale.", "The human must sign in on the supported upstream page and recheck identity.", "yellow");
    if (!provider.warehouseBinding?.upstreamWarehouse || provider.warehouseBinding.siteId !== actor.siteId || provider.warehouseBinding.contractId !== approval.warehouseBindingContractId || !fresh(provider.warehouseBinding.verifiedAt, now, definition.limits.identityMaxAgeMs)) return block("warehouse-binding", "The actual upstream warehouse binding is missing, stale or different.", "Qualify the upstream warehouse mapping; do not infer it from an order ID.", "yellow");
    if (provider.kind === "browser") {
      try {
        if (!provider.page || !fresh(provider.page.independentlyVerifiedAt, now, definition.limits.identityMaxAgeMs) || exactIntegrationOrigin(provider.page.origin) !== definition.origin || !integrationPathMatches(provider.page.pathname, definition.pagePathPrefix)) return block("actual-page", "The independently verified provider page is not the approved origin/path.", "Open the correct supported page and reconnect its own adapter.");
      } catch { return block("actual-page", "The provider page is invalid or unsupported.", "Open the exact approved site; never export its cookies or bypass CSP."); }
    }
  }
  const readiness = provider.actionReadiness[definition.key];
  if (readiness?.state !== "ready") return block("action-not-ready", readiness?.reason || "The transport is not yet ready for this named action.", "Resolve this action's stated identity/configuration/device requirement.", "yellow");
  const requestHash = await integrationContentHash({ actionVersionId: version.id, publicationId: publication.id, pins, input: values, request, run: context.run ?? null });
  if (!context.operationId || context.operationId.length > 100) return block("operation-id", "A bounded durable operation ID is required.", "Reuse the original ID after a lost result; do not generate a new dispatch.");
  const previous = context.operation;
  if (previous) {
    if (previous.operationId !== context.operationId || previous.actorUserId !== actor.userId || previous.siteId !== actor.siteId || previous.providerId !== provider.id || previous.actionVersionId !== version.id || previous.requestHash !== requestHash) return block("operation-reuse", "The operation ID was reused with different inputs, actor, site or pins.", "Inspect the original authorized receipt and reconcile the mismatch.");
    if (context.phase !== "claim" || previous.state !== "queued") return { kind: "existing", receiptId: previous.id, state: previous.state, mayRedispatch: false };
    if (context.expectedOperationRevision !== previous.revision) return block("operation-revision", "The queued operation changed before claim.", "Reload its original receipt; claim by compare-and-swap in the writer.");
  } else if (context.phase === "claim") return block("operation-missing", "There is no durable queued operation to claim.", "Persist the authorized intent before attempting an external effect.");
  const phase = context.phase ?? "prepare";
  if (!Number.isSafeInteger(context.inFlight) || !Number.isSafeInteger(context.queued) || context.inFlight < 0 || context.queued < 0 || (phase === "claim" && context.inFlight >= definition.limits.maxConcurrent) || (phase === "prepare" && (definition.limits.maxQueued === 0 ? context.queued > 0 || context.inFlight >= definition.limits.maxConcurrent : context.queued >= definition.limits.maxQueued))) return block("provider-backpressure", "The selected provider's bounded concurrency or queue is full.", "Wait for original receipts; do not accumulate or reroute work.", "yellow");
  return { kind: "ready", effect: definition.effect, execution: context.mode === "dry-run" ? "simulate" : phase === "prepare" ? "enqueue" : "dispatch", phase, actorUserId: actor.userId, actorSessionId: actor.sessionId, actorGrantId: actor.oauthGrantId ?? null, providerOwnerUserId: provider.ownerUserId, providerOwnerSessionId: provider.ownerSessionId, providerOwnerDeviceId: provider.ownerDeviceId, providerOwnerTabId: provider.ownerTabId, physicalPrinterId: provider.physicalPrinterId ?? null, siteId: actor.siteId, grantId: grant?.id ?? null, pins: { ...pins }, operationId: context.operationId, requestHash, request, input: values, run: context.run ? { ...context.run } : null };
}

export interface StoredProviderRoute { id: string; userId: string; siteId: string; deviceId: string; integrationId: string; purpose: "read" | "write" | "print"; providerId: string; revision: number; enabled: boolean }
/** A default preselects an ID only. It creates neither authority nor fallback. */
export function chooseProviderRoute(routes: readonly StoredProviderRoute[], providers: readonly ProviderRecord[], actor: CurrentActorAuthority, input: { integrationId: string; purpose: StoredProviderRoute["purpose"]; expectedRouteRevision: number }, now: number): { kind: "selected"; providerId: string; routeId: string } | PolicyBlock {
  const inactive = actorFailure(actor, now); if (inactive) return inactive;
  const matches = routes.filter(route => route.enabled && route.userId === actor.userId && route.siteId === actor.siteId && route.deviceId === actor.deviceId && route.integrationId === input.integrationId && route.purpose === input.purpose);
  if (matches.length !== 1) return block("route-selection", "No unique explicit provider default is configured for this person/device/warehouse.", "Select one approved provider default; no estate-wide or other-user fallback is used.");
  const route = matches[0], provider = providers.find(provider => provider.id === route.providerId);
  if (route.revision !== input.expectedRouteRevision) return block("route-version", "The selected provider default changed.", "Review and pin the intended provider again.");
  if (!provider || provider.siteId !== actor.siteId || provider.integrationId !== input.integrationId || provider.revokedAt !== null || provider.leaseExpiresAt <= now || provider.transport !== "connected") return block("route-provider-unavailable", "The explicitly selected provider is unavailable.", "Reconnect or explicitly replace that default; never silently reroute writes.", "yellow");
  return { kind: "selected", providerId: provider.id, routeId: route.id };
}

export interface PrinterQueueJob {
  id: string; siteId: string; physicalPrinterId: string; providerId: string; requesterUserId: string;
  runId: string | null; stepId: string | null; operationId: string; position: number; revision: number;
  state: "queued" | "dispatching" | "acknowledged" | "physically-confirmed" | "failed" | "unknown" | "cancelled";
}
export type PrinterClaim = PolicyBlock | { kind: "existing"; jobId: string; state: PrinterQueueJob["state"]; physicalPrintConfirmed: boolean; mayRedispatch: false } | { kind: "claim"; jobId: string; expectedRevision: number; physicalPrinterId: string; providerId: string; requesterUserId: string; runId: string | null; stepId: string | null; physicalPrintConfirmed: false };
/** Run under one physical-printer queue lock, then CAS queued -> dispatching. ACK is never physical proof. */
export function decidePrinterClaim(jobs: readonly PrinterQueueJob[], request: { jobId: string; siteId: string; requesterUserId: string; physicalPrinterId: string; providerId: string; expectedRevision: number }, authority: DispatchDecision): PrinterClaim {
  if (authority.kind !== "ready" || authority.effect !== "print" || authority.execution !== "dispatch" || authority.phase !== "claim" || authority.siteId !== request.siteId || authority.actorUserId !== request.requesterUserId || authority.pins.providerId !== request.providerId || authority.physicalPrinterId !== request.physicalPrinterId) return block("printer-authority", "No current claimed print-effect authority covers this job/provider.", "Recheck the separate print grant and queued operation in the same writer.");
  const job = jobs.find(job => job.id === request.jobId);
  if (!job || job.siteId !== request.siteId || job.requesterUserId !== request.requesterUserId || job.physicalPrinterId !== request.physicalPrinterId || job.providerId !== request.providerId) return block("printer-job-scope", "This print job is not in the requester's authorized warehouse/provider scope.", "Inspect the authorized original print receipt.");
  if (job.operationId !== authority.operationId || job.runId !== (authority.run?.id ?? null) || job.stepId !== (authority.run?.stepId ?? null)) return block("printer-operation", "The authorized operation/run/step does not match this print job.", "Use this job's original pinned intent; do not mix output between runs.");
  if (job.state !== "queued") return { kind: "existing", jobId: job.id, state: job.state, physicalPrintConfirmed: job.state === "physically-confirmed", mayRedispatch: false };
  if (job.revision !== request.expectedRevision) return block("printer-job-revision", "The print job changed before claim.", "Reload the original receipt and compare-and-swap its queued revision.");
  const siblings = jobs.filter(other => other.physicalPrinterId === job.physicalPrinterId && other.id !== job.id);
  if (siblings.some(other => other.state === "dispatching" || other.state === "unknown")) return block("printer-busy", "This physical printer has in-flight or uncertain output.", "Reconcile its original job before sending another person's output.", "yellow");
  if (siblings.some(other => other.state === "queued" && (other.position < job.position || (other.position === job.position && other.id < job.id)))) return block("printer-queue-order", "An earlier job is waiting for this physical printer.", "Wait for the coordinated queue; do not mix requester output.", "yellow");
  return { kind: "claim", jobId: job.id, expectedRevision: job.revision, physicalPrinterId: job.physicalPrinterId, providerId: job.providerId, requesterUserId: job.requesterUserId, runId: job.runId, stepId: job.stepId, physicalPrintConfirmed: false };
}
