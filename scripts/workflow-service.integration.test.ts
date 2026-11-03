import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withPrincipalSite } from "../lib/sites/context";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import type { WorkflowCommand } from "../lib/workflows/engine";
import { SYNTHETIC_RECEIVING_DEFINITION } from "../lib/workflows/receiving";

const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("persisted workflows enforce site/current authority and execute only local practice", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  process.env.DATABASE_URL = url; process.env.TEMCO_PILOT_MODE = "read_only_dmp";
  const service = await import("../lib/workflows/service");
  const { prisma } = await import("../lib/db");
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID(), at = new Date(), expiry = new Date(at.getTime() + 3600_000);
  const sites = await Promise.all(["a", "b"].map(suffix => owner.warehouseSite.create({ data: { id: `workflow-${ns}-${suffix}`, slug: `workflow-${ns}-${suffix}`, name: `Synthetic workflow ${suffix}` } })));
  const users = await Promise.all(["manager", "operator"].map(kind => owner.user.create({ data: { username: `workflow-${ns}-${kind}`, displayName: `Synthetic ${kind}`, pinHash: "disabled:v2", passwordHash: "synthetic-unusable-hash", role: "user" } })));
  const roles = await Promise.all(sites.map(site => owner.warehouseRole.create({ data: { siteId: site.id, name: "Synthetic workflow manager", capabilities: ["workflow.read", "workflows.manage"] } })));
  const memberships = await Promise.all(sites.map((site, index) => owner.warehouseMembership.create({ data: { siteId: site.id, userId: users[0].id, roles: { create: { roleId: roles[index].id } } } })));
  const operatorRole = await owner.warehouseRole.create({ data: { siteId: sites[0].id, name: "Synthetic practice operator", capabilities: ["workflow.read"] } });
  await owner.warehouseMembership.create({ data: { siteId: sites[0].id, userId: users[1].id, roles: { create: { roleId: operatorRole.id } } } });
  const sessions = await Promise.all(users.map(user => owner.userSession.create({ data: { id: `workflow-session-${randomUUID()}`, userId: user.id, authVersion: 1, activeSiteId: sites[0].id, expiresAt: expiry, lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, deviceLabel: "Synthetic workflow fixture" } })));
  async function principal(userIndex: number, siteIndex = 0): Promise<Principal> {
    const session = sessions[userIndex], claim = { userId: users[userIndex].id, authVersion: 1, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: expiry.getTime() };
    const result = await resolvePrincipal(claim, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), sites[siteIndex].id); assert.ok(result); return { ...result, sessionId: session.id, strongAuthenticatedAt: at.getTime(), mfaVerifiedAt: at.getTime() };
  }
  const manager = await principal(0), managerB = await principal(0, 1), operator = await principal(1);
  const as = <T>(p: Principal, run: () => T) => withPrincipalSite(p, run);
  const op = () => randomUUID();
  const localDefinition = { id: "custom-local", versionId: "draft-v1", version: 1, configurationVersion: "workflow-local-config-v1", name: "Local practice", mode: "synthetic", steps: [
    { id: "entry", kind: "form", title: "Enter identifier", saveAs: "entry", fields: [{ key: "identifier", label: "Identifier", type: "identifier" }] },
    { id: "echo", kind: "action", title: "Local echo", action: { id: "workflow.local.echo", versionId: "workflow-local-echo-v1", configurationVersion: "workflow-local-config-v1", capability: "workflow.read", effect: "local" }, parameters: { identifier: { source: "data", path: ["entry", "identifier"] } } },
  ] };
  try {
    await t.test("workflow.read starts built-in practice; management, current scope and fresh MFA are separate", async () => {
      const started = await as(operator, () => service.startWorkflow(operator, { operationId: op(), template: "synthetic_receiving" }));
      assert.equal(started.run.siteId, sites[0].id); assert.equal(started.run.createdByUserId, operator.userId); assert.equal(started.run.status, "human");
      await assert.rejects(as(operator, () => service.createWorkflowDraft(operator, { operationId: op(), name: "Forbidden", definition: localDefinition })), /permission/);
      await assert.rejects(as(manager, () => service.getWorkflowRun(manager, { runId: "missing-run" })), /not found/);
      await assert.rejects(as(managerB, () => service.getWorkflowRun(managerB, { runId: started.run.id })), /not found/);
      await assert.rejects(as(operator, () => service.commandWorkflow(operator, { runId: started.run.id, commandId: op(), expectedRevision: 1, definitionVersionId: started.run.definitionVersionId, command: { kind: "action_result", intentId: "fake", result: { outcome: "succeeded", receiptId: "fake" } } })));
      const draft = await as(manager, () => service.createWorkflowDraft(manager, { operationId: op(), name: "MFA protected", definition: localDefinition }));
      await owner.userSession.update({ where: { id: sessions[0].id }, data: { mfaVerifiedAt: null } });
      await assert.rejects(as(manager, () => service.publishWorkflow(manager, { operationId: op(), id: draft.id, expectedRevision: draft.revision, note: "Synthetic publication" })), /authenticator/);
      await owner.userSession.update({ where: { id: sessions[0].id }, data: { mfaVerifiedAt: at } });
      const narrow = { ...manager, capabilities: ["workflow.read"] as const };
      await assert.rejects(as(narrow, () => service.publishWorkflow(narrow, { operationId: op(), id: draft.id, expectedRevision: draft.revision, note: "Synthetic publication" })), /permission/);
    });
    await t.test("Receiving persists independent scans/ACKs/physical confirmations/unit receipts and no operational rows", async () => {
      const before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } });
      let view = await as(manager, () => service.startWorkflow(manager, { operationId: op(), template: "synthetic_receiving" }));
      async function command(command: WorkflowCommand) { view = await as(manager, () => service.commandWorkflow(manager, { runId: view.run.id, commandId: op(), expectedRevision: view.run.revision, definitionVersionId: view.run.definitionVersionId, command })); return view; }
      await command({ kind: "submit", values: { deliveryId: "SYNTHETIC-INBOUND-001" } }); assert.equal(view.run.currentStepId, "scan");
      await command({ kind: "scan", eventId: "scan-A", rawValue: "SYNTHETIC-LPN-A01" });
      await command({ kind: "scan", eventId: "duplicate-A", rawValue: "SYNTHETIC-LPN-A01" });
      await assert.rejects(command({ kind: "finish_scan" }), /Exact required quantities/);
      await command({ kind: "scan", eventId: "unexpected", rawValue: "SYNTHETIC-OTHER" });
      await command({ kind: "scan", eventId: "scan-B", rawValue: "SYNTHETIC-LPN-B01" });
      await command({ kind: "resolve_capture", eventId: "unexpected", reason: "Unrelated fixture label reviewed" });
      await command({ kind: "finish_scan" });
      assert.equal(view.run.currentStepId, "verifyLabels"); assert.equal(view.receiving?.operations.every(value => value.kind === "label" && value.status === "acknowledged"), true);
      assert.equal(view.receivingReadiness?.labelsUnconfirmed.length, 2); assert.equal(view.receiving?.closed, false);
      await command({ kind: "confirm", accepted: true, note: "Synthetic labels physically applied" });
      assert.equal(view.run.status, "completed"); assert.equal(view.receiving?.closed, true);
      assert.equal(view.receiving?.operations.filter(value => value.kind === "receipt").every(value => value.status === "confirmed"), true);
      assert.equal(view.intents.length, 4); assert.equal(view.intents.every(value => value.state === "succeeded"), true);
      assert.equal(view.events.every(value => value.actorUserId === manager.userId && value.actorSessionId === manager.sessionId), true);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
      await assert.rejects(as(operator, () => service.getWorkflowRun(operator, { runId: view.run.id })), /not found/);
      await assert.rejects(as(operator, () => service.commandWorkflow(operator, { runId: view.run.id, commandId: op(), expectedRevision: view.run.revision, definitionVersionId: view.run.definitionVersionId, command: { kind: "refresh" } })), /not found/);
    });
    await t.test("generic definitions edit/test/publish/version/rollback without retargeting active runs", async () => {
      const trial = await as(manager, () => service.testWorkflowDraft(manager, { definition: localDefinition, commands: [{ kind: "submit", values: { identifier: "SYNTHETIC-ONE" } }] }));
      assert.equal(trial.persisted, false); assert.equal(trial.run.status, "completed"); assert.deepEqual(trial.run.steps.echo.output, { identifier: "SYNTHETIC-ONE" });
      const draft = await as(manager, () => service.createWorkflowDraft(manager, { operationId: op(), name: "Versioned local practice", definition: localDefinition }));
      await assert.rejects(as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: draft.id })), /published/);
      const first = await as(manager, () => service.publishWorkflow(manager, { operationId: op(), id: draft.id, expectedRevision: 1, note: "Publish local fixture v1" }));
      const started = await as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: draft.id }));
      const changed = { ...localDefinition, steps: [{ ...localDefinition.steps[0], title: "Changed v2 form" }, localDefinition.steps[1]] };
      await as(manager, () => service.saveWorkflowDraft(manager, { operationId: op(), id: draft.id, expectedRevision: 2, name: "Local v2", definition: changed }));
      const second = await as(manager, () => service.publishWorkflow(manager, { operationId: op(), id: draft.id, expectedRevision: 3, note: "Publish local fixture v2" }));
      const retained = await as(manager, () => service.getWorkflowRun(manager, { runId: started.run.id }));
      assert.equal(retained.run.definitionVersionId, first.published.id); assert.equal(retained.run.definition.steps[0].title, "Enter identifier");
      const newer = await as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: draft.id })); assert.equal(newer.run.definitionVersionId, second.published.id);
      await as(manager, () => service.rollbackWorkflow(manager, { operationId: op(), id: draft.id, expectedRevision: 4, versionId: first.published.id, note: "Restore fixture v1 pointer" }));
      const restored = await as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: draft.id })); assert.equal(restored.run.definitionVersionId, first.published.id);
      await assert.rejects(as(manager, () => service.saveWorkflowDraft(manager, { operationId: op(), id: draft.id, expectedRevision: 1, name: "Stale", definition: localDefinition })), /changed/);
    });
    await t.test("simultaneous commands commit once and replay returns retained results without another intent", async () => {
      const draft = await as(manager, () => service.createWorkflowDraft(manager, { operationId: op(), name: "CAS fixture", definition: localDefinition }));
      await as(manager, () => service.publishWorkflow(manager, { operationId: op(), id: draft.id, expectedRevision: 1, note: "Publish CAS fixture" }));
      const started = await as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: draft.id }));
      const input = { runId: started.run.id, commandId: op(), expectedRevision: started.run.revision, definitionVersionId: started.run.definitionVersionId, command: { kind: "submit" as const, values: { identifier: "SYNTHETIC-CAS" } } };
      const outcomes = await Promise.allSettled([as(manager, () => service.commandWorkflow(manager, input)), as(manager, () => service.commandWorkflow(manager, { ...input, commandId: op() }))]);
      assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1); assert.equal(outcomes.filter(value => value.status === "rejected").length, 1);
      const winner = outcomes.find(value => value.status === "fulfilled"); assert.ok(winner && winner.status === "fulfilled");
      const event = winner.value.events.find(value => value.kind === "operator_command")!;
      const repeated = { ...input, commandId: event.commandId };
      const replay = await as(manager, () => service.commandWorkflow(manager, repeated)); assert.equal(replay.replayed, true); assert.equal(replay.intents.length, 1);
      await assert.rejects(as(manager, () => service.commandWorkflow(manager, { ...repeated, command: { kind: "submit", values: { identifier: "ALTERED" } } })), /different work/);
      assert.equal(await owner.workflowIntentRecord.count({ where: { runId: started.run.id } }), 1);
    });
    await t.test("disable/current membership/role revocation apply to saved runs and live mode never dispatches", async () => {
      const draft = await as(manager, () => service.createWorkflowDraft(manager, { operationId: op(), name: "Disable fixture", definition: localDefinition }));
      await as(manager, () => service.publishWorkflow(manager, { operationId: op(), id: draft.id, expectedRevision: 1, note: "Publish disable fixture" }));
      const started = await as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: draft.id }));
      await as(manager, () => service.setWorkflowEnabled(manager, { operationId: op(), id: draft.id, expectedRevision: 2, enabled: false, note: "Disable this local fixture" }));
      const read = await as(manager, () => service.getWorkflowRun(manager, { runId: started.run.id })); assert.equal(read.readiness.status, "red");
      await assert.rejects(as(manager, () => service.commandWorkflow(manager, { runId: started.run.id, commandId: op(), expectedRevision: started.run.revision, definitionVersionId: started.run.definitionVersionId, command: { kind: "submit", values: { identifier: "BLOCKED" } } })), /authority/);
      const liveDraft = await as(manager, () => service.createWorkflowDraft(manager, { operationId: op(), name: "Unqualified live", definition: { ...localDefinition, mode: "live" } }));
      await as(manager, () => service.publishWorkflow(manager, { operationId: op(), id: liveDraft.id, expectedRevision: 1, note: "Store design only, no adapter" }));
      await assert.rejects(as(manager, () => service.startWorkflow(manager, { operationId: op(), definitionId: liveDraft.id })), /Live workflow execution is unavailable/);
      await owner.warehouseRole.update({ where: { id: roles[0].id }, data: { capabilities: ["workflow.read"] } });
      await assert.rejects(as(manager, () => service.createWorkflowDraft(manager, { operationId: op(), name: "Revoked management", definition: localDefinition })), /permission/);
      await owner.warehouseMembership.update({ where: { id: memberships[0].id }, data: { isActive: false } });
      await assert.rejects(as(manager, () => service.getWorkflowRun(manager, { runId: started.run.id })), /warehouse access/);
    });
    await t.test("published list pagination remains site-scoped and template source stays synthetic", async () => {
      const first = await as(managerB, () => service.listWorkflows(managerB, { limit: 1 })); assert.equal(first.workflows.length, 0); assert.equal(first.siteId, sites[1].id);
      assert.equal(first.templates[0].definition.mode, "synthetic"); assert.equal(SYNTHETIC_RECEIVING_DEFINITION.mode, "synthetic");
    });
  } finally { await Promise.all([owner.$disconnect(), prisma.$disconnect()]); }
});
