import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Capability, type Principal } from "@/lib/auth/principal";
import * as identity from "@/lib/auth/identity";
import * as mfa from "@/lib/auth/mfa";
import * as units from "@/lib/warehouse/units";
import * as reports from "@/lib/warehouse/reports";
import * as payloads from "@/lib/payloads/service";
import * as office from "@/lib/office/service";
import { listOAuthGrants, revokeOAuthGrant } from "@/lib/oauth/service";
import { getToolFavorites, saveToolFavorites } from "@/lib/tool-favorites-store";
import { parseFavoriteChange } from "@/lib/tool-favorites";
import { labelActions } from "./label-actions";
import { adminActions } from "./admin-actions";
import { pickActions } from "./pick-actions";
import { inventoryActions } from "./inventory-actions";
import { dispatchActions } from "./dispatch-actions";
import { listActions } from "./list-actions";
import { getOperationalDashboard, saveDashboardPreferences } from "@/lib/dashboard";
import * as dmp from "@/lib/api-relay/service";
import { validatePayloadDraft, buildPayloadBookmarklet } from "@/lib/payloads/model";
import { lookupWarehouseInventory } from "@/lib/warehouse-lookup";
import { ingestWarehouseScan } from "./scan-ingestion";
import { createAccessGrant, listAccessGrants, revokeAccessGrant } from "./grants";

type Action = { capability?: Capability; capabilitiesAny?: readonly Capability[]; adminOnly?: boolean; description: string; run: (principal: Principal, input: unknown) => unknown | Promise<unknown> };
const record = (input: unknown) => z.record(z.string(), z.unknown()).parse(input);
const text = (input: unknown, key: string) => z.string().trim().min(1).max(200).parse(record(input)[key]);
const withInput = <T>(fn: (principal: Principal, input: T) => unknown | Promise<unknown>) => (principal: Principal, input: unknown) => fn(principal, input as T);
const userCeremony = (principal: Principal, action: () => unknown | Promise<unknown>) => principal.grantId
  ? { status: "requires_user_interaction", actionUrl: `${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin}/account/security`, instruction: "Open Account security in your own session to complete this credential/authenticator ceremony, then inspect its status. Do not send passwords, authenticator secrets or recovery codes to an MCP client." }
  : action();

// One explicit application action list. UI APIs and MCP call these same domain
// services; no arbitrary URL, JS execution, user impersonation or DB tunnel.
export const applicationActions = {
  ...labelActions,
  ...adminActions,
  ...pickActions,
  ...inventoryActions,
  ...dispatchActions,
  ...listActions,
  "dashboard.get": { description: "Read authorized operational priorities, progress and source timestamps", run: getOperationalDashboard },
  "dashboard.save": { capability: "account.self", description: "Select and reorder your authorized home widgets", run: saveDashboardPreferences },
  "dmp.status": { capability: "workflow.read", description: "List your paired DMP tabs and named operations", run: dmp.getDmpStatus },
  "dmp.pair": { capability: "workflow.read", description: "Issue a one-use pairing approval for a configured signed-in DMP page", run: dmp.pairDmp },
  "dmp.lease": { capability: "workflow.read", description: "Renew the live relay lease within your current individual session", run: dmp.renewDmpLease },
  "dmp.disconnect": { capability: "workflow.read", description: "Disconnect one of your external-page relays", run: dmp.disconnectDmp },
  "dmp.request": { capability: "workflow.read", description: "Run one named DMP operation with durable intent ID; mutations also require execute authority and are never replayed", run: dmp.requestDmpOperation },
  "dmp.receipts": { capability: "workflow.read", description: "List your durable DMP intent receipts without stored customer payloads", run: dmp.listDmpReceipts },
  "dmp.receipt": { capability: "workflow.read", description: "Inspect an original DMP operation after lost response; never resend it", run: dmp.getDmpReceipt },
  "dmp.reconcile": { capability: "office.decide", description: "Record evidence from upstream inspection of your uncertain intent; never dispatch a retry", run: dmp.reconcileDmpOperation },
  "warehouse.lookup": { capability: "inventory.read", description: "Exact LPN or separate order candidates", run: lookupWarehouseInventory },
  "warehouse.resolve": { capability: "inventory.read", description: "Resolve typed aliases without order-only merging", run: withInput(units.resolveWarehouseIdentifier) },
  "warehouse.unit": { capability: "inventory.read", description: "Unit history and independent physical observations", run: withInput(units.getWarehouseUnit) },
  "warehouse.unit.observations": { capability: "inventory.read", description: "Page the full retained physical observation/correction history", run: withInput(units.getWarehouseUnitObservations) },
  "warehouse.unit.revisions": { capability: "inventory.read", description: "Page the full retained source-row history", run: withInput(units.getWarehouseSourceRevisions) },
  "warehouse.unit.export": { capability: "inventory.read", description: "Export a consistent retained unit history snapshot", run: withInput(units.exportWarehouseUnitHistory) },
  "warehouse.unresolved": { capability: "inventory.read", description: "Review unknown or ambiguous observations", run: (p: Principal) => units.listUnresolvedWarehouseObservations(p) },
  "warehouse.observe": { capability: "inventory.write", description: "Persist one attributed physical event; safe same-event retries", run: withInput(units.recordWarehouseObservation) },
  "warehouse.scan": { capability: "inventory.write", description: "Record global evidence and evaluate optional Pick Wave work", run: ingestWarehouseScan },
  "warehouse.unit.create": { capability: "inventory.identify", description: "Create an evidenced physical-unit identity", run: withInput(units.createWarehouseUnit) },
  "warehouse.alias.link": { capability: "inventory.identify", description: "Link an identifier with attribution and evidence", run: withInput(units.linkWarehouseIdentifier) },
  "warehouse.alias.unlink": { capability: "inventory.identify", description: "Revoke an identifier link while retaining history", run: withInput(units.unlinkWarehouseIdentifier) },
  "warehouse.observation.correct": { capability: "inventory.identify", description: "Amend an observation link, retaining original evidence", run: withInput(units.correctWarehouseObservation) },
  "warehouse.import": { capability: "inventory.write", description: "One shared WMS import with history and explicit scope/coverage", run: reports.importSharedWarehouseReport },
  "warehouse.put-away": { capability: "inventory.read", description: "Saved Placing view over accepted WMS data", run: withInput(reports.getWarehousePutAway) },
  "warehouse.put-away.export": { capability: "inventory.read", description: "Export the selected shared Put Away view", run: withInput(reports.exportWarehousePutAway) },
  "warehouse.membership": { capability: "inventory.read", description: "Inspect report membership separately from physical stock", run: withInput(reports.getWarehouseImportMembership) },
  "identity.sessions": { capability: "account.self", description: "List your current individual sessions", run: identity.listSessions },
  "identity.session.revoke": { capability: "account.self", description: "Revoke one of your sessions", run: identity.revokeSession },
  "identity.session.lock": { capability: "account.self", description: "Lock your current shared-device session", run: identity.lockSession },
  "identity.sessions.revoke-others": { capability: "account.self", description: "End your other individual sessions", run: identity.revokeOtherSessions },
  "identity.password.change": { capability: "account.self", description: "Initiate password change through your own secure account session", run: (p: Principal, input: unknown) => userCeremony(p, () => identity.changePassword(p, input, { source: "shared-command" })) },
  "identity.reauthenticate": { capability: "account.self", description: "Initiate secure password/authenticator confirmation in your own account", run: (p: Principal, input: unknown) => userCeremony(p, () => identity.reauthenticate(p, input, { source: "shared-command" })) },
  "identity.mfa.status": { capability: "account.self", description: "Read your authenticator enrollment state", run: mfa.getMfaStatus },
  "identity.mfa.begin": { capability: "account.self", description: "Initiate authenticator setup through your secure account session", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.beginMfaEnrollment(p, input, { source: "shared-command" })) },
  "identity.mfa.confirm": { capability: "account.self", description: "Initiate confirmation of your pending authenticator in your secure session", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.confirmMfaEnrollment(p, input, { source: "shared-command" })) },
  "identity.mfa.verify": { capability: "account.self", description: "Initiate authenticator verification through your own secure session", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.verifyMfa(p, input, { source: "shared-command" })) },
  "identity.mfa.recovery.regenerate": { capability: "account.self", description: "Initiate replacement of recovery codes through your secure account", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.regenerateMfaRecoveryCodes(p, input, { source: "shared-command" })) },
  "identity.mfa.disable": { capability: "account.self", description: "Initiate factor removal with proof and last-administrator protection", run: (p: Principal, input: unknown) => userCeremony(p, () => mfa.disableMfa(p, input, { source: "shared-command" })) },
  "identity.users": { capability: "users.manage", description: "List users and assigned bundles", run: (p: Principal, input: unknown) => identity.listIdentityUsers(p, z.string().max(200).parse(record(input).search ?? "")) },
  "identity.user.create": { capability: "users.manage", description: "Create an account for assisted strong enrollment", run: identity.createIdentityUser },
  "identity.user.update": { capability: "users.manage", description: "Change access/assignment with current strong authorization", run: identity.updateIdentityUser },
  "identity.recovery.issue": { capability: "users.manage", description: "Issue one-use assisted enrollment/reset authorization", run: identity.issueRecovery },
  "identity.bundles": { capability: "users.manage", description: "List capability-backed role bundles", run: identity.listRoleBundles },
  "identity.bundle.save": { capability: "users.manage", description: "Create/change a bundle without silently granting legacy users new rights", run: identity.saveRoleBundle },
  "identity.audit": { capability: "users.manage", description: "Review access and recovery attribution without credentials", run: identity.listIdentityAudit },
  "access.grants": { capability: "account.self", description: "List your scoped client grants", run: listAccessGrants },
  "access.grant.create": { capability: "account.self", description: "Create an expiring user/session-bound grant within your client scope", run: createAccessGrant },
  "access.grant.revoke": { capability: "account.self", description: "Revoke your client grant", run: (p: Principal, input: unknown) => revokeAccessGrant(p, text(input, "id")) },
  "access.oauth.grants": { capability: "account.self", description: "List your remote MCP client grants", run: listOAuthGrants },
  "access.oauth.revoke": { capability: "account.self", description: "Revoke your remote MCP client grant", run: (p: Principal, input: unknown) => revokeOAuthGrant(p, text(input, "id")) },
  "tools.favorites": { capability: "account.self", description: "Read your authorized favorite tools", run: getToolFavorites },
  "tools.favorites.save": { capability: "account.self", description: "Save or reorder your authorized favorite tools", run: (p: Principal, input: unknown) => saveToolFavorites(p, parseFavoriteChange(input)) },
  "office.cases": { capability: "workflow.read", description: "Review durable office cases without recreating resolved issues", run: office.listOfficeCases },
  "office.case": { capability: "workflow.read", description: "Read a case and its attributed history", run: office.getOfficeCase },
  "office.unit": { capability: "workflow.read", description: "Read exact-unit schedules, exchange trail and dispositions", run: office.getOfficeUnitContext },
  "office.people": { capability: "office.decide", description: "Choose an active responsible person", run: office.getOfficePeople },
  "office.returns": { capability: "workflow.read", description: "Explain expected-return and MARS reconciliation gaps", run: office.getExpectedReturnWorklist },
  "office.schedule.record": { capability: "office.decide", description: "Record an explicitly manual, evidenced unit schedule fact", run: office.recordOfficeSchedule },
  "office.exchange.create": { capability: "office.decide", description: "Link separate original/replacement units through an exchange", run: office.createOfficeExchange },
  "office.attempt.record": { capability: "office.decide", description: "Record a delivery outcome without falsely completing physical movement", run: office.recordOfficeExchangeAttempt },
  "office.return.expect": { capability: "office.decide", description: "Record why an exact unit is expected back", run: office.createOfficeReturnExpectation },
  "office.case.manage": { capability: "office.decide", description: "Assign, watch, resolve or reopen a durable case", run: office.manageOfficeCase },
  "office.disposition.create": { capabilitiesAny: ["office.decide", "office.authorize_rtv"], description: "Record handling instructions; exact disposition/RTV authority is separately checked", run: office.createOfficeDisposition },
  "office.disposition.revoke": { capabilitiesAny: ["office.decide", "office.authorize_rtv"], description: "Revoke an instruction with its specific authority while retaining history", run: office.revokeOfficeDisposition },
  "office.disposition.execute": { capability: "workflow.execute", description: "Confirm actual authorized exact-unit placement using qualifying evidence", run: office.recordOfficeDispositionExecution },
  "office.evaluate": { capabilitiesAny: ["inventory.write", "office.decide"], description: "Evaluate a bounded page using current inventory-write or office-decision authority", run: office.evaluateOfficeWork },
  "office.observation.review": { capability: "inventory.write", description: "Evaluate instructions triggered by your captured physical event", run: office.reviewOfficeObservation },
  "payloads.list": { capability: "payloads.manage", adminOnly: true, description: "List managed external-page payloads", run: payloads.listPayloads },
  "payloads.get": { capability: "payloads.manage", adminOnly: true, description: "Read private source/draft/version history", run: (p: Principal, input: unknown) => payloads.getPayload(p, text(input, "id")) },
  "payloads.version": { capability: "payloads.manage", adminOnly: true, description: "Inspect an immutable source version", run: (p: Principal, input: unknown) => payloads.getPayloadVersion(p, text(input, "id"), text(input, "versionId")) },
  "payloads.create": { capability: "payloads.manage", adminOnly: true, description: "Create a named purpose/origin-constrained draft", run: withInput(payloads.createPayload) },
  "payloads.draft.save": { capability: "payloads.manage", adminOnly: true, description: "Save source with an expected revision", run: withInput(payloads.savePayloadDraft) },
  "payloads.publish": { capability: "payloads.manage", adminOnly: true, description: "Explicitly publish reviewed immutable source", run: withInput(payloads.publishPayload) },
  "payloads.rollback": { capability: "payloads.manage", adminOnly: true, description: "Move publication to a known immutable version", run: withInput(payloads.rollbackPayload) },
  "payloads.enabled": { capability: "payloads.manage", adminOnly: true, description: "Enable/disable new payload execution", run: withInput(payloads.setPayloadEnabled) },
  "payloads.preview": { capability: "payloads.manage", adminOnly: true, description: "Return a synthetic isolated preview without network/account authority", run: payloads.previewPayloadDraft },
  "payloads.validate": { capability: "payloads.manage", adminOnly: true, description: "Compile/check a draft without running its source", run: (_p: Principal, input: unknown) => { const draft = validatePayloadDraft(input); return { valid: true, purpose: draft.purpose, sourceBytes: Buffer.byteLength(draft.source) }; } },
  "payloads.bookmarklet": { capability: "payloads.manage", adminOnly: true, description: "Generate a stable payload loader bookmarklet", run: async (p: Principal, input: unknown) => { const id = text(input, "id"); await payloads.getPayload(p, id); const origin = z.string().url().parse(process.env.NEXT_PUBLIC_APP_URL); return { loaderUrl: `${new URL(origin).origin}/api/payloads/${id}/loader`, bookmarklet: buildPayloadBookmarklet(`${new URL(origin).origin}/api/payloads/${id}/loader`) }; } },
} satisfies Record<string, Action>;

export type ApplicationAction = keyof typeof applicationActions;
export function listApplicationActions(principal: Principal) {
  return Object.entries(applicationActions).filter(([, definition]) => {
    const action: Action = definition;
    return (!action.capability || principal.capabilities.includes(action.capability)) && (!action.capabilitiesAny || action.capabilitiesAny.some(cap => principal.capabilities.includes(cap))) && (!action.adminOnly || principal.role === "admin");
  }).map(([name, definition]) => ({ name, description: definition.description }));
}
export async function executeApplicationAction(principal: Principal, name: string, input: unknown) {
  if (!Object.hasOwn(applicationActions, name)) throw new Error("Unknown application action.");
  const action: Action = applicationActions[name as ApplicationAction];
  if (action.capability) assertCapability(principal, action.capability);
  if (action.capabilitiesAny && !action.capabilitiesAny.some(cap => principal.capabilities.includes(cap))) throw new identity.IdentityError("Your current permissions do not allow this action.", 403);
  if (action.adminOnly && principal.role !== "admin") throw new identity.IdentityError("System administrator access required.", 403);
  await prisma.$transaction(tx => identity.assertCurrentPrincipal(tx, principal, action.capability));
  return action.run(principal, input);
}
