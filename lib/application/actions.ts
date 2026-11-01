import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Capability, type Principal } from "@/lib/auth/principal";
import * as identity from "@/lib/auth/identity";
import * as mfa from "@/lib/auth/mfa";
import * as units from "@/lib/warehouse/units";
import * as reports from "@/lib/warehouse/reports";
import * as payloads from "@/lib/payloads/service";
import * as samples from "@/lib/dmp-samples";
import * as sites from "@/lib/relay-sites/service";
import { connectTemcoBookmarklet } from "@/lib/relay-sites/model";
import { pilotPolicy, pilotCapabilityAllowed } from "../../scripts/pilot-policy.mjs";
import * as office from "@/lib/office/service";
import { listOAuthGrants, revokeOAuthGrant } from "@/lib/oauth/service";
import { getToolFavorites, saveToolFavorites } from "@/lib/tool-favorites-store";
import { parseFavoriteChange, favoriteChangeInput } from "@/lib/tool-favorites";
import { labelActions } from "./label-actions";
import { adminActions } from "./admin-actions";
import { pickActions } from "./pick-actions";
import { inventoryActions } from "./inventory-actions";
import { physicalStockActions } from "./physical-stock-actions";
import { officeRefreshActions } from "./office-refresh-actions";
import { dispatchActions } from "./dispatch-actions";
import { listActions } from "./list-actions";
import { noteActions } from "./note-actions";
import { marsActions } from "./mars-actions";
import { utilityActions } from "./utility-actions";
import { getUnitLabelContext, evaluateUnitLabels, prepareUnitLabel, unitLabelContextInput, prepareUnitLabelInput } from "@/lib/labels/unit-context";
import { getOperationalDashboard, saveDashboardPreferences, dashboardPreferencesInput } from "@/lib/dashboard";
import * as dmp from "@/lib/api-relay/service";
import { validatePayloadDraft, buildPayloadBookmarklet, payloadDraftInput } from "@/lib/payloads/model";
import { lookupWarehouseInventory, warehouseLookupInput } from "@/lib/warehouse-lookup";
import { ingestWarehouseScan, scanIngestionSchema } from "./scan-ingestion";
import { getConnectedClientSetup, connectedClientSetupInput } from "./client-setup";
import { createAccessGrant, listAccessGrants, revokeAccessGrant } from "./grants";

type Action = { capability?: Capability; capabilitiesAll?: readonly Capability[]; capabilitiesAny?: readonly Capability[]; adminOnly?: boolean; humanInteraction?: boolean; description: string; inputSchema?: z.ZodType; run: (principal: Principal, input: unknown) => unknown | Promise<unknown> };
const record = (input: unknown) => z.record(z.string(), z.unknown()).parse(input);
const text = (input: unknown, key: string) => z.string().trim().min(1).max(200).parse(record(input)[key]);
const humanHandoffInput = z.object({}).strict().describe("Initiate the human UI handoff with no credential inputs. Never send passwords, authenticator secrets or recovery codes to MCP.");
const withInput = <T>(fn: (principal: Principal, input: T) => unknown | Promise<unknown>) => (principal: Principal, input: unknown) => fn(principal, input as T);
const userCeremony = (principal: Principal, action: () => unknown | Promise<unknown>, path = "/account/security") => principal.grantId
  ? { status: "requires_user_interaction", actionUrl: `${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin}${path}`, instruction: "Open this page in your own authenticated session to complete the credential/authenticator ceremony, then inspect its status. Do not send passwords, authenticator secrets or recovery codes to an MCP client." }
  : action();

// One explicit application action list. UI APIs and MCP call these same domain
// services; no arbitrary URL, JS execution, user impersonation or DB tunnel.
export const applicationActions = {
  ...labelActions,
  ...adminActions,
  ...pickActions,
  ...inventoryActions,
  ...physicalStockActions,
  ...dispatchActions,
  ...officeRefreshActions,
  ...listActions,
  ...noteActions,
  ...marsActions,
  ...utilityActions,
  "warehouse.unit.context": { capability: "inventory.read", capabilitiesAll: ["workflow.read"], description: "Read source-qualified unit, office, exchange, return and label field context without claiming upstream qualification", inputSchema: unitLabelContextInput, run: getUnitLabelContext },
  "labels.unit.evaluate": { capability: "labels.read", capabilitiesAll: ["inventory.read", "workflow.read"], description: "Evaluate due unit labels from server-derived dates/routes/instructions; unrelated scans do not reissue", inputSchema: unitLabelContextInput, run: evaluateUnitLabels },
  "labels.unit.prepare": { capability: "labels.print", capabilitiesAll: ["inventory.read", "workflow.read"], description: "Prepare an identified unit label using authoritative current context and an authorized connected device", inputSchema: prepareUnitLabelInput, run: prepareUnitLabel },
  "dashboard.get": { description: "Read authorized operational priorities, progress and source timestamps", inputSchema: z.object({}), run: getOperationalDashboard },
  "dashboard.save": { capability: "account.self", description: "Select and reorder your authorized home widgets", inputSchema: dashboardPreferencesInput, run: saveDashboardPreferences },
  "dmp.status": { capability: "workflow.read", description: "List your paired DMP tabs and named operations", inputSchema: z.object({}), run: dmp.getDmpStatus },
  "environment.policy": { capability: "account.self", description: "Read environment restrictions without credentials or a claim of live connectivity", inputSchema: z.object({}).strict(), run: () => pilotPolicy() },
  "relay.connect.bookmarklet": { capability: "workflow.read", description: "Generate the single stable Connect TemcoTools injector; reports only origin/pathname, with no caller-supplied URL or source execution", inputSchema: z.object({}).strict(), run: () => ({ bookmarklet: connectTemcoBookmarklet(z.string().url().parse(process.env.NEXT_PUBLIC_APP_URL)), context: "origin_and_pathname_only", authority: "Published site selection is not authentication; per-system pairing remains required." }) },
  "relay.sites.list": { capability: "payloads.manage", adminOnly: true, description: "List exact-origin/path payload mappings and their current revisions", inputSchema: sites.siteProfilesListInput, run: sites.listSiteProfiles },
  "relay.sites.save": { capability: "payloads.manage", adminOnly: true, description: "Create or revise an approved site mapping with current strong administrator authority and revision", inputSchema: sites.siteProfileSaveInput, run: sites.saveSiteProfile },
  "relay.sites.enabled": { capability: "payloads.manage", adminOnly: true, description: "Enable or disable a site mapping after current administrator and revision checks", inputSchema: sites.siteProfileEnabledInput, run: sites.setSiteProfileEnabled },
  "relay.sites.remove": { capability: "payloads.manage", adminOnly: true, description: "Remove a site mapping retaining denial/history; deliberate restoration uses its current revision", inputSchema: sites.siteProfileRemoveInput, run: sites.removeSiteProfile },
  "dmp.share.approve": { capability: "workflow.read", humanInteraction: true, description: "Open the human approval page for an expiring named-read share with your own OAuth client; a client cannot approve itself", run: (p: Principal, input: unknown) => userCeremony(p, () => dmp.approveDmpShare(p, input), "/tools/api-relay") },
  "dmp.share.revoke": { capability: "workflow.read", humanInteraction: true, description: "Open your human DMP connection page to revoke a read share", run: (p: Principal, input: unknown) => userCeremony(p, () => dmp.revokeDmpShare(p, input), "/tools/api-relay") },
  "dmp.samples.list": { capability: "workflow.read", description: "List your privately retained body-only source samples; no live adapter or global coverage is implied", inputSchema: samples.dmpSamplesListInput, run: samples.listDmpSamples },
  "dmp.samples.save": { capability: "workflow.read", description: "Explicitly retain a bounded private JSON/CSV/XML body or authorized managed export with source/date/method provenance; rejects credentials and HAR", inputSchema: samples.dmpSamplesSaveInput, run: samples.saveDmpSample },
  "dmp.samples.inspect": { capability: "workflow.read", description: "Inspect bounded structure/counts/types; explicit fieldPath reveals only bounded values from your own private sample", inputSchema: samples.dmpSamplesInspectInput, run: samples.inspectDmpSample },
  "dmp.samples.routeContext": { capability: "workflow.read", description: "Inspect route-local ordered XML stop/line context without deduplicating legs or inferring code meanings, unit identity or movement completion", inputSchema: samples.dmpSamplesRouteContextInput, run: samples.getDmpSampleRouteContext },
  "dmp.samples.remove": { capability: "workflow.read", description: "Remove your retained sample using its current content hash and a durable operation ID", inputSchema: samples.dmpSamplesRemoveInput, run: samples.removeDmpSample },
  "dmp.pair": { capability: "workflow.read", description: "Issue a one-use pairing approval for a configured signed-in DMP page", inputSchema: dmp.dmpPairInput, run: dmp.pairDmp },
  "dmp.lease": { capability: "workflow.read", description: "Renew the live relay lease within your current individual session", inputSchema: z.object({}), run: dmp.renewDmpLease },
  "dmp.disconnect": { capability: "workflow.read", description: "Disconnect one of your external-page relays", inputSchema: dmp.dmpConnectionInput, run: dmp.disconnectDmp },
  "dmp.request": { capability: "workflow.read", description: "Run one named DMP operation with durable intent ID; mutations also require execute authority and are never replayed", inputSchema: dmp.dmpRequestInput, run: dmp.requestDmpOperation },
  "dmp.receipts": { capability: "workflow.read", description: "List your durable DMP intent receipts without stored customer payloads", inputSchema: z.object({}), run: dmp.listDmpReceipts },
  "dmp.receipt": { capability: "workflow.read", description: "Inspect an original DMP operation after lost response; never resend it", inputSchema: dmp.dmpReceiptInput, run: dmp.getDmpReceipt },
  "dmp.reconcile": { capability: "office.decide", description: "Record evidence from upstream inspection of your uncertain intent; never dispatch a retry", inputSchema: dmp.dmpReconcileInput, run: dmp.reconcileDmpOperation },
  "warehouse.lookup": { capability: "inventory.read", description: "Exact LPN or separate order candidates", inputSchema: warehouseLookupInput, run: lookupWarehouseInventory },
  "warehouse.resolve": { capability: "inventory.read", description: "Resolve typed aliases without order-only merging", inputSchema: units.warehouseIdentifierInput, run: withInput(units.resolveWarehouseIdentifier) },
  "warehouse.unit": { capability: "inventory.read", description: "Unit history and independent physical observations", inputSchema: units.warehouseUnitInput, run: withInput(units.getWarehouseUnit) },
  "warehouse.unit.observations": { capability: "inventory.read", description: "Page the full retained physical observation/correction history", inputSchema: units.warehouseHistoryInput, run: withInput(units.getWarehouseUnitObservations) },
  "warehouse.unit.revisions": { capability: "inventory.read", description: "Page the full retained source-row history", inputSchema: units.warehouseHistoryInput, run: withInput(units.getWarehouseSourceRevisions) },
  "warehouse.unit.export": { capability: "inventory.read", description: "Export a consistent retained unit history snapshot", inputSchema: units.warehouseUnitInput, run: withInput(units.exportWarehouseUnitHistory) },
  "warehouse.unresolved": { capability: "inventory.read", description: "Review unknown or ambiguous observations", inputSchema: z.object({}), run: (p: Principal) => units.listUnresolvedWarehouseObservations(p) },
  "warehouse.observe": { capability: "inventory.write", description: "Persist one attributed physical event; safe same-event retries", inputSchema: units.warehouseObservationInput, run: withInput(units.recordWarehouseObservation) },
  "warehouse.scan": { capability: "inventory.write", description: "Record global evidence and evaluate optional Pick Wave work", inputSchema: scanIngestionSchema, run: ingestWarehouseScan },
  "warehouse.unit.create": { capability: "inventory.identify", description: "Create an evidenced physical-unit identity", inputSchema: units.warehouseCreateInput, run: withInput(units.createWarehouseUnit) },
  "warehouse.alias.link": { capability: "inventory.identify", description: "Link an identifier with attribution and evidence", inputSchema: units.warehouseAliasInput, run: withInput(units.linkWarehouseIdentifier) },
  "warehouse.alias.unlink": { capability: "inventory.identify", description: "Revoke an identifier link while retaining history", inputSchema: units.warehouseUnlinkInput, run: withInput(units.unlinkWarehouseIdentifier) },
  "warehouse.observation.correct": { capability: "inventory.identify", description: "Amend an observation link, retaining original evidence", inputSchema: units.warehouseCorrectionInput, run: withInput(units.correctWarehouseObservation) },
  "warehouse.import": { capability: "inventory.write", description: "One shared WMS import with history and explicit scope/coverage", inputSchema: reports.warehouseReportInput, run: reports.importSharedWarehouseReport },
  "warehouse.put-away": { capability: "inventory.read", description: "Saved Placing view over accepted WMS data", inputSchema: reports.warehousePutAwayInput, run: withInput(reports.getWarehousePutAway) },
  "warehouse.put-away.export": { capability: "inventory.read", description: "Export the selected shared Put Away view", inputSchema: reports.warehousePutAwayInput.omit({ limit: true, afterLpn: true }), run: withInput(reports.exportWarehousePutAway) },
  "warehouse.membership": { capability: "inventory.read", description: "Inspect report membership separately from physical stock", inputSchema: reports.warehouseMembershipInput, run: withInput(reports.getWarehouseImportMembership) },
  "identity.sessions": { capability: "account.self", description: "List your current individual sessions", inputSchema: z.object({}), run: identity.listSessions },
  "identity.session.revoke": { capability: "account.self", description: "Revoke one of your sessions", inputSchema: identity.identitySessionRevokeInput, run: identity.revokeSession },
  "identity.session.lock": { capability: "account.self", description: "Lock your current shared-device session", inputSchema: z.object({}), run: identity.lockSession },
  "identity.sessions.revoke-others": { capability: "account.self", description: "End your other individual sessions", inputSchema: z.object({}), run: identity.revokeOtherSessions },
  "identity.password.change": { capability: "account.self", humanInteraction: true, description: "Initiate password change through your own secure account session", run: (p: Principal, input: unknown) => userCeremony(p, () => identity.changePassword(p, input, { source: "shared-command" })) },
  "identity.reauthenticate": { capability: "account.self", humanInteraction: true, description: "Initiate secure password/authenticator confirmation in your own account", run: (p: Principal, input: unknown) => userCeremony(p, () => identity.reauthenticate(p, input, { source: "shared-command" })) },
  "identity.mfa.status": { capability: "account.self", description: "Read your authenticator enrollment state", inputSchema: z.object({}), run: mfa.getMfaStatus },
  "identity.mfa.begin": { capability: "account.self", humanInteraction: true, description: "Initiate authenticator setup through your secure account session", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.beginMfaEnrollment(p, input, { source: "shared-command" })) },
  "identity.mfa.confirm": { capability: "account.self", humanInteraction: true, description: "Initiate confirmation of your pending authenticator in your secure session", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.confirmMfaEnrollment(p, input, { source: "shared-command" })) },
  "identity.mfa.verify": { capability: "account.self", humanInteraction: true, description: "Initiate authenticator verification through your own secure session", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.verifyMfa(p, input, { source: "shared-command" })) },
  "identity.mfa.recovery.regenerate": { capability: "account.self", humanInteraction: true, description: "Initiate replacement of recovery codes through your secure account", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.regenerateMfaRecoveryCodes(p, input, { source: "shared-command" })) },
  "identity.mfa.disable": { capability: "account.self", humanInteraction: true, description: "Initiate factor removal with proof and last-administrator protection", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.disableMfa(p, input, { source: "shared-command" })) },
  "identity.users": { capability: "users.manage", description: "List users and assigned bundles", inputSchema: z.object({ search: z.string().max(200).optional() }), run: (p: Principal, input: unknown) => identity.listIdentityUsers(p, z.string().max(200).parse(record(input).search ?? "")) },
  "identity.user.create": { capability: "users.manage", description: "Create an account for assisted strong enrollment", inputSchema: identity.identityCreateUserInput, run: identity.createIdentityUser },
  "identity.user.update": { capability: "users.manage", description: "Change access/assignment with current strong authorization", inputSchema: identity.identityUpdateUserInput, run: identity.updateIdentityUser },
  "identity.recovery.issue": { capability: "users.manage", humanInteraction: true, description: "Initiate a private assisted enrollment/reset handoff through the authorized administrator", run: (p: Principal, input: unknown) => userCeremony(p, () => identity.issueRecovery(p, input), "/admin/users") },
  "identity.factor-reset.issue": { capability: "users.manage", humanInteraction: true, description: "Initiate a private exact-person lost-factor recovery with current administrator proof", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.issueAssistedFactorReset(p, input), "/admin/users") },
  "identity.bundles": { capability: "users.manage", description: "List capability-backed role bundles", inputSchema: z.object({}), run: identity.listRoleBundles },
  "identity.bundle.save": { capability: "users.manage", description: "Create/change a bundle without silently granting legacy users new rights", inputSchema: identity.identitySaveBundleInput, run: identity.saveRoleBundle },
  "identity.audit": { capability: "users.manage", description: "Review access and recovery attribution without credentials", inputSchema: z.object({}), run: identity.listIdentityAudit },
  "access.setup": { capability: "account.self", description: "Read validated configured MCP setup, reachability limits and your recorded private/OAuth permissions without exposing credentials", inputSchema: connectedClientSetupInput, run: getConnectedClientSetup },
  "access.grants": { capability: "account.self", description: "List your scoped client grants", inputSchema: z.object({}), run: listAccessGrants },
  "access.grant.create": { capability: "account.self", humanInteraction: true, description: "Initiate a user/session-bound client grant through your own account; delegated clients cannot mint replacements", run: (p: Principal, input: unknown) => userCeremony(p, () => createAccessGrant(p, input), "/account/access") },
  "access.grant.revoke": { capability: "account.self", description: "Revoke your client grant", inputSchema: z.object({ id: z.string().min(1).max(200) }), run: (p: Principal, input: unknown) => revokeAccessGrant(p, text(input, "id")) },
  "access.oauth.grants": { capability: "account.self", description: "List your remote MCP client grants", inputSchema: z.object({}), run: listOAuthGrants },
  "access.oauth.revoke": { capability: "account.self", description: "Revoke your remote MCP client grant", inputSchema: z.object({ id: z.string().min(1).max(200) }), run: (p: Principal, input: unknown) => revokeOAuthGrant(p, text(input, "id")) },
  "tools.favorites": { capability: "account.self", description: "Read your currently authorized tool catalog, names, URLs and favorite IDs within your client scope", inputSchema: z.object({}), run: getToolFavorites },
  "tools.favorites.save": { capability: "account.self", description: "Save or reorder your authorized favorite tools", inputSchema: favoriteChangeInput, run: (p: Principal, input: unknown) => saveToolFavorites(p, parseFavoriteChange(input)) },
  "office.cases": { capability: "workflow.read", description: "Review durable office cases without recreating resolved issues", inputSchema: office.listOfficeCasesInputSchema, run: office.listOfficeCases },
  "office.case": { capability: "workflow.read", description: "Read a case and its attributed history", inputSchema: office.getOfficeCaseInputSchema, run: office.getOfficeCase },
  "office.unit": { capability: "workflow.read", description: "Read exact-unit schedules, exchange trail and dispositions", inputSchema: office.getOfficeUnitContextInputSchema, run: office.getOfficeUnitContext },
  "office.people": { capability: "office.decide", description: "Choose an active responsible person", inputSchema: office.getOfficePeopleInputSchema, run: office.getOfficePeople },
  "office.returns": { capability: "workflow.read", description: "Explain expected-return and MARS reconciliation gaps", inputSchema: office.getExpectedReturnWorklistInputSchema, run: office.getExpectedReturnWorklist },
  "office.schedule.record": { capability: "office.decide", description: "Record an explicitly manual, evidenced unit schedule fact", inputSchema: office.recordOfficeScheduleInputSchema, run: office.recordOfficeSchedule },
  "office.exchange.create": { capability: "office.decide", description: "Link separate original/replacement units through an exchange", inputSchema: office.createOfficeExchangeInputSchema, run: office.createOfficeExchange },
  "office.attempt.record": { capability: "office.decide", description: "Record a delivery outcome without falsely completing physical movement", inputSchema: office.recordOfficeExchangeAttemptInputSchema, run: office.recordOfficeExchangeAttempt },
  "office.return.expect": { capability: "office.decide", description: "Record why an exact unit is expected back", inputSchema: office.createOfficeReturnExpectationInputSchema, run: office.createOfficeReturnExpectation },
  "office.case.manage": { capability: "office.decide", description: "Assign, watch, resolve or reopen a durable case", inputSchema: office.manageOfficeCaseInputSchema, run: office.manageOfficeCase },
  "office.disposition.create": { capabilitiesAny: ["office.decide", "office.authorize_rtv"], description: "Record handling instructions; exact disposition/RTV authority is separately checked", inputSchema: office.createOfficeDispositionInputSchema, run: office.createOfficeDisposition },
  "office.disposition.revoke": { capabilitiesAny: ["office.decide", "office.authorize_rtv"], description: "Revoke an instruction with its specific authority while retaining history", inputSchema: office.revokeOfficeDispositionInputSchema, run: office.revokeOfficeDisposition },
  "office.disposition.execute": { capability: "workflow.execute", description: "Confirm actual authorized exact-unit placement using qualifying evidence", inputSchema: office.recordOfficeDispositionExecutionInputSchema, run: office.recordOfficeDispositionExecution },
  "office.evaluate": { capabilitiesAny: ["inventory.write", "office.decide"], description: "Evaluate a bounded page using current inventory-write or office-decision authority", inputSchema: office.evaluateOfficeWorkInputSchema, run: office.evaluateOfficeWork },
  "office.observation.review": { capability: "inventory.write", description: "Evaluate instructions triggered by your captured physical event", inputSchema: office.reviewOfficeObservationInputSchema, run: office.reviewOfficeObservation },
  "payloads.list": { capability: "payloads.manage", adminOnly: true, description: "List managed external-page payloads", inputSchema: z.object({}), run: payloads.listPayloads },
  "payloads.builtin-sources": { capability: "payloads.manage", adminOnly: true, description: "Read built-in DMP and review-only MARS helper source for an explicit managed draft", inputSchema: z.object({}), run: (p: Principal) => payloads.getBuiltinPayloadSources(p) },
  "payloads.get": { capability: "payloads.manage", adminOnly: true, description: "Read private source/draft/version history", inputSchema: payloads.payloadGetInput, run: (p: Principal, input: unknown) => payloads.getPayload(p, payloads.payloadGetInput.parse(input).id) },
  "payloads.version": { capability: "payloads.manage", adminOnly: true, description: "Inspect an immutable source version", inputSchema: payloads.payloadVersionInput, run: (p: Principal, input: unknown) => { const data = payloads.payloadVersionInput.parse(input); return payloads.getPayloadVersion(p, data.id, data.versionId); } },
  "payloads.versions": { capability: "payloads.manage", adminOnly: true, description: "Page immutable source versions before an optional version number", inputSchema: payloads.payloadVersionsInput, run: (p: Principal, input: unknown) => { const data = payloads.payloadVersionsInput.parse(input); return payloads.listPayloadVersions(p, data.id, data.beforeVersion); } },
  "payloads.create": { capability: "payloads.manage", adminOnly: true, description: "Create a named purpose/origin-constrained draft", inputSchema: payloads.payloadCreateInput, run: withInput(payloads.createPayload) },
  "payloads.draft.save": { capability: "payloads.manage", adminOnly: true, description: "Save source with an expected revision", inputSchema: payloads.payloadDraftSaveInput, run: withInput(payloads.savePayloadDraft) },
  "payloads.publish": { capability: "payloads.manage", adminOnly: true, description: "Explicitly publish reviewed immutable source", inputSchema: payloads.payloadPublishInput, run: withInput(payloads.publishPayload) },
  "payloads.rollback": { capability: "payloads.manage", adminOnly: true, description: "Move publication to a known immutable version", inputSchema: payloads.payloadRollbackInput, run: withInput(payloads.rollbackPayload) },
  "payloads.enabled": { capability: "payloads.manage", adminOnly: true, description: "Enable/disable new payload execution", inputSchema: payloads.payloadEnabledInput, run: withInput(payloads.setPayloadEnabled) },
  "payloads.preview": { capability: "payloads.manage", adminOnly: true, description: "Return a synthetic DOM preview without app session or relay authority; frame self-navigation is not qualified", inputSchema: payloadDraftInput, run: payloads.previewPayloadDraft },
  "payloads.validate": { capability: "payloads.manage", adminOnly: true, description: "Compile/check a draft without running its source", inputSchema: payloadDraftInput, run: (_p: Principal, input: unknown) => { const draft = validatePayloadDraft(input); return { valid: true, purpose: draft.purpose, sourceBytes: Buffer.byteLength(draft.source) }; } },
  "payloads.bookmarklet": { capability: "payloads.manage", adminOnly: true, description: "Generate a stable payload loader bookmarklet", inputSchema: payloads.payloadGetInput, run: async (p: Principal, input: unknown) => { const { id } = payloads.payloadGetInput.parse(input); await payloads.getPayload(p, id); const origin = z.string().url().parse(process.env.NEXT_PUBLIC_APP_URL); return { loaderUrl: `${new URL(origin).origin}/api/payloads/${id}/loader`, bookmarklet: buildPayloadBookmarklet(`${new URL(origin).origin}/api/payloads/${id}/loader`) }; } },
} satisfies Record<string, Action>;

export type ApplicationAction = keyof typeof applicationActions;
export function listApplicationActions(principal: Principal, options: { prefix?: string; includeSchemas?: boolean } = {}) {
  const has = (cap: Capability) => principal.capabilities.includes(cap) && pilotCapabilityAllowed(cap);
  return Object.entries(applicationActions).filter(([, definition]) => {
    const action: Action = definition;
    return (!action.capability || has(action.capability)) && (!action.capabilitiesAll || action.capabilitiesAll.every(has)) && (!action.capabilitiesAny || action.capabilitiesAny.some(has)) && (!action.adminOnly || principal.role === "admin");
  }).filter(([name]) => !options.prefix || name.startsWith(options.prefix)).map(([name, definition]) => {
    const action: Action = definition;
    const schema = action.humanInteraction ? humanHandoffInput : action.inputSchema;
    return {
      name, description: action.description,
      ...(action.humanInteraction ? { requiresUserInteraction: true } : {}),
      ...(options.includeSchemas && schema ? { inputSchema: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) } : {}),
    };
  });
}
export async function executeApplicationAction(principal: Principal, name: string, input: unknown) {
  if (!Object.hasOwn(applicationActions, name)) throw new identity.IdentityError("Unknown application action.", 404);
  const action: Action = applicationActions[name as ApplicationAction];
  if (action.capability) assertCapability(principal, action.capability);
  for (const cap of action.capabilitiesAll ?? []) assertCapability(principal, cap);
  if (action.capabilitiesAny && !action.capabilitiesAny.some(cap => principal.capabilities.includes(cap))) throw new identity.IdentityError("Your current permissions do not allow this action.", 403);
  if (action.adminOnly && principal.role !== "admin") throw new identity.IdentityError("System administrator access required.", 403);
  const current = await prisma.$transaction(tx => identity.assertCurrentPrincipal(tx, principal, action.capability));
  for (const cap of action.capabilitiesAll ?? []) assertCapability(current, cap);
  if (action.capabilitiesAny && !action.capabilitiesAny.some(cap => current.capabilities.includes(cap))) throw new identity.IdentityError("Your current client scope no longer allows this action.", 403);
  if (action.adminOnly && current.role !== "admin") throw new identity.IdentityError("System administrator access required.", 403);
  return action.run(current, action.inputSchema ? action.inputSchema.parse(input) : input);
}
