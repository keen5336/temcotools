import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withPrincipalSite } from "../lib/sites/context";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import { copyWorkflowJson } from "../lib/workflows/definition";
import type { WorkflowCommand } from "../lib/workflows/engine";

const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("application workflows reuse real scoped warehouse services without external effects", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  process.env.DATABASE_URL = url; process.env.TEMCO_PILOT_MODE = "read_only_dmp"; process.env.NEXT_PUBLIC_APP_URL = "https://synthetic-temco.example.invalid";
  const service = await import("../lib/workflows/service"), { prisma } = await import("../lib/db");
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID(), at = new Date();
  const sites = await Promise.all(["a", "b"].map(name => owner.warehouseSite.create({ data: { slug: `workflow-domain-${ns}-${name}`, name: `Synthetic workflow domain ${name}` } })));
  const user = await owner.user.create({ data: { username: `workflow-domain-${ns}`, displayName: "Synthetic domain operator", role: "user", pinHash: "disabled:v2", passwordHash: "synthetic-nonlogin-value" } });
  const capabilities = ["workflow.read", "workflows.manage", "inventory.read", "inventory.write"];
  const roles = await Promise.all(sites.map(site => owner.warehouseRole.create({ data: { siteId: site.id, name: "Synthetic workflow domain role", capabilities } })));
  const memberships = await Promise.all(sites.map((site, index) => owner.warehouseMembership.create({ data: { siteId: site.id, userId: user.id, roles: { create: { roleId: roles[index].id } } } })));
  const session = await owner.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: 1, activeSiteId: sites[0].id, expiresAt: new Date(at.getTime() + 3600_000), mfaVerifiedAt: at, deviceLabel: "Synthetic workflow domain fixture" } });
  async function principal(siteId = sites[0].id): Promise<Principal> { const p = await resolvePrincipal({ userId: user.id, authVersion: 1, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), siteId); assert.ok(p); return { ...p, sessionId: session.id }; }
  const p = await principal(), other = await principal(sites[1].id), as = <T>(who: Principal, fn: () => T) => withPrincipalSite(who, fn), op = () => randomUUID();
  const units = await Promise.all([0, 0, 1].map(index => owner.warehouseUnit.create({ data: { siteId: sites[index].id, createdByUserId: user.id, creationEvidence: "Synthetic workflow domain fixture only" } })));
  const lpn = `SYNTHETIC-DOMAIN-${ns}-A`.toUpperCase(), replacement = `SYNTHETIC-DOMAIN-${ns}-B`.toUpperCase(), msn = `SYNTHETIC-MSN-${ns}`.toUpperCase(), ambiguous = `SYNTHETIC-SUBMISSION-${ns}`.toUpperCase();
  await Promise.all([0, 1].map(index => owner.inventoryAuditItem.create({ data: { siteId: sites[0].id, lpn: index ? replacement : lpn, status: "SYNTHETIC-REPORTED", orderNumber: "SYNTHETIC-SHARED-ORDER", vendor: "Synthetic", receivedDate: "2026-11-03", description: "Synthetic fixture appliance", customerName: "Synthetic", sourceData: { fixture: true }, contentHash: `synthetic-${index}`, unitId: units[index].id } })));
  const alias = (unitIndex: number, value: string, kind: string, namespace: string) => owner.warehouseIdentifier.create({ data: { siteId: units[unitIndex].siteId, unitId: units[unitIndex].id, value, rawValue: value, kind, namespace, evidence: "Synthetic alias evidence", createdByUserId: user.id } });
  const primaryAlias = await alias(0, lpn, "lpn", "wms"); await alias(0, msn, "msn", "dmp"); await alias(1, replacement, "lpn", "wms"); await alias(0, ambiguous, "submission", "mars"); await alias(1, ambiguous, "submission", "mars"); await alias(2, lpn, "lpn", "wms");
  type View = Awaited<ReturnType<typeof service.getWorkflowRun>>;
  async function start(template: "warehouse_presence" = "warehouse_presence") { return as(p, () => service.startWorkflow(p, { operationId: op(), template })); }
  function commandInput(view: View, command: WorkflowCommand) { return { runId: view.run.id, commandId: op(), expectedRevision: view.run.revision, definitionVersionId: view.run.definitionVersionId, command }; }
  async function command(view: View, cmd: WorkflowCommand) { return as(p, () => service.commandWorkflow(p, commandInput(view, cmd))); }
  async function captured(value: string) { return command(await start(), { kind: "submit", values: { rawIdentifier: value, captureMethod: "manual", location: "SYNTHETIC-LANE-A" } }); }
  async function publish(definition: unknown) {
    const draft = await as(p, () => service.createWorkflowDraft(p, { operationId: op(), name: "Synthetic composed application workflow", definition }));
    await as(p, () => service.publishWorkflow(p, { operationId: op(), id: draft.id, expectedRevision: draft.revision, note: "Synthetic application workflow fixture" })); return draft;
  }
  try {
    await t.test("catalog exposes exact supported versions/schemas and real lookup never claims physical presence", async () => {
      const catalog = await as(p, () => service.getWorkflowActionCatalog(p, {}));
      assert.ok(catalog.actions.some(action => action.id === "warehouse.resolve" && action.effect === "read" && action.capability === "inventory.read" && action.ready));
      assert.ok(catalog.actions.some(action => action.id === "warehouse.observe" && action.capability === "inventory.write" && action.modes.includes("application")));
      assert.equal(catalog.externalLiveExecutionAvailable, false); assert.equal(catalog.handoffs.find(item => item.kind === "camera")?.ready, false);
      const view = await captured(msn), output = view.run.steps.lookup.output as { unitId: string; candidateUnitIds: string[]; physicalPresence: string; candidates: Array<{ reportedRows: unknown[] }> };
      assert.equal(view.run.definition.mode, "application"); assert.equal(output.unitId, units[0].id); assert.deepEqual(output.candidateUnitIds, [units[0].id]); assert.equal(output.physicalPresence, "not_determined");
      assert.equal(output.candidates[0].reportedRows.length, 1); assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), 0);
      await assert.rejects(as(other, () => service.getWorkflowRun(other, { runId: view.run.id })), /not found/);
    });
    await t.test("retained native lookup requires current read permission without requiring a future write", async () => {
      const view = await captured(msn);
      await owner.warehouseRole.update({ where: { id: roles[0].id }, data: { capabilities: capabilities.filter(cap => cap !== "inventory.write") } });
      try {
        const readable = await as(p, () => service.getWorkflowRun(p, { runId: view.run.id }));
        assert.equal(readable.run.currentStepId, "confirmPresence");
        assert.equal((readable.run.steps.lookup.output as { unitId: string }).unitId, units[0].id);
        await owner.warehouseRole.update({ where: { id: roles[0].id }, data: { capabilities: capabilities.filter(cap => cap !== "inventory.read") } });
        // workflows.manage is still present. It is not authority for retained inventory data.
        await assert.rejects(as(p, () => service.getWorkflowRun(p, { runId: view.run.id })), /inventory.read.*scope/);
        const metadata = await as(p, () => service.listWorkflowRuns(p, {}));
        assert.ok(metadata.runs.some(row => row.id === view.run.id));
        assert.equal(JSON.stringify(metadata).includes(msn), false);
      } finally { await owner.warehouseRole.update({ where: { id: roles[0].id }, data: { capabilities } }); }
      const retained = await as(p, () => service.getWorkflowRun(p, { runId: view.run.id }));
      assert.equal((retained.run.steps.lookup.output as { unitId: string }).unitId, units[0].id);
    });
    await t.test("explicit confirmation commits one real native observation and retries keep its original receipt", async () => {
      const view = await captured(lpn), before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), input = commandInput(view, { kind: "confirm", accepted: true, note: "Synthetic physical observation confirmed", method: "human" });
      const done = await as(p, () => service.commandWorkflow(p, input)); assert.equal(done.run.status, "completed");
      const output = done.run.steps.observe.output as { observation: { observationId: string; capturedAt: string; captureMethod: string; capturedByUserId: string }; unitId: string };
      assert.equal(output.unitId, units[0].id); assert.equal(output.observation.capturedByUserId, user.id); assert.equal(output.observation.captureMethod, "manual"); assert.equal(output.observation.capturedAt, view.run.steps.capture.completedAt);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before + 1);
      const replay = await as(p, () => service.commandWorkflow(p, input)); assert.equal(replay.replayed, true); assert.equal((replay.run.steps.observe.output as { observation: { observationId: string } }).observation.observationId, output.observation.observationId);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before + 1);
      assert.equal(done.intents.length, 2); assert.ok(done.events.some(event => event.kind === "application_action_result"));
    });
    await t.test("ambiguous identifiers and order-only context never merge original/replacement units", async () => {
      const view = await captured(ambiguous), lookup = view.run.steps.lookup.output as { resolution: string; unitId: string | null; candidateUnitIds: string[] };
      assert.equal(lookup.resolution, "ambiguous"); assert.equal(lookup.unitId, null); assert.equal(lookup.candidateUnitIds.length, 2);
      const done = await command(view, { kind: "confirm", accepted: true }); const receipt = done.run.steps.observe.output as { resolution: string; unitId: string | null };
      assert.equal(receipt.resolution, "ambiguous"); assert.equal(receipt.unitId, null);
      const order = await captured("SYNTHETIC-SHARED-ORDER"); assert.equal((order.run.steps.lookup.output as { resolution: string }).resolution, "unresolved");
    });
    await t.test("current write capability/membership are rechecked after run creation before any observation", async () => {
      let view = await captured(lpn), before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } });
      await owner.warehouseRole.update({ where: { id: roles[0].id }, data: { capabilities: capabilities.filter(cap => cap !== "inventory.write") } });
      view = await command(view, { kind: "confirm", accepted: true }); assert.equal(view.run.status, "blocked"); assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
      await owner.warehouseRole.update({ where: { id: roles[0].id }, data: { capabilities } });
      view = await command(view, { kind: "refresh" }); assert.equal(view.run.status, "completed"); assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before + 1);
      const pending = await captured(lpn); before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } });
      await owner.warehouseMembership.update({ where: { id: memberships[0].id }, data: { isActive: false } });
      await assert.rejects(command(pending, { kind: "confirm", accepted: true }), /warehouse access/); assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
      await owner.warehouseMembership.update({ where: { id: memberships[0].id }, data: { isActive: true } });
    });
    await t.test("draft trials can read but never persist observations, and unknown versions remain blocked", async () => {
      const before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } });
      const trial = await as(p, () => service.testWorkflowDraft(p, { definition: service.WAREHOUSE_PRESENCE_DEFINITION, commands: [{ kind: "submit", values: { rawIdentifier: lpn, captureMethod: "scanner" } }, { kind: "confirm", accepted: true }] }));
      assert.equal(trial.run.status, "blocked"); assert.equal(trial.persisted, false); assert.match(trial.readiness.blocking[0].reason, /Draft testing/); assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
      const altered = copyWorkflowJson(service.WAREHOUSE_PRESENCE_DEFINITION), lookup = altered.steps.find(step => step.kind === "action" && step.action.id === "warehouse.resolve"); assert.ok(lookup?.kind === "action"); lookup.action.versionId = "warehouse-resolve-unregistered-v2";
      const draft = await publish(altered), run = await as(p, () => service.startWorkflow(p, { operationId: op(), definitionId: draft.id }));
      const blocked = await command(run, { kind: "submit", values: { rawIdentifier: lpn, captureMethod: "manual" } }); assert.equal(blocked.run.status, "blocked"); assert.equal(blocked.intents.length, 0);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
    });
    await t.test("camera/device handoffs cannot be forged; an explicit manual fallback stays attributed as manual", async () => {
      const strict = copyWorkflowJson(service.WAREHOUSE_PRESENCE_DEFINITION), confirm = strict.steps.find(step => step.kind === "confirm"); assert.ok(confirm?.kind === "confirm"); confirm.handoff = "camera";
      const draft = await publish(strict), initial = await as(p, () => service.startWorkflow(p, { operationId: op(), definitionId: draft.id }));
      const pending = await command(initial, { kind: "submit", values: { rawIdentifier: lpn, captureMethod: "manual" } });
      assert.equal(pending.handoff?.kind, "camera"); assert.equal(pending.handoff?.deviceVerified, false); assert.match(pending.handoff?.actionUrl ?? "", /^https:\/\/synthetic-temco\.example\.invalid/);
      await assert.rejects(command(pending, { kind: "confirm", accepted: true }), /qualified camera\/device/);
      await assert.rejects(as(p, () => service.commandWorkflow(p, { ...commandInput(pending, { kind: "confirm", accepted: true }), command: { kind: "confirm", accepted: true, deviceVerified: true } })), /Unrecognized/);
      confirm.manualFallback = true; const fallbackDraft = await publish(strict), fallback = await as(p, () => service.startWorkflow(p, { operationId: op(), definitionId: fallbackDraft.id }));
      const capturedView = await command(fallback, { kind: "submit", values: { rawIdentifier: lpn, captureMethod: "manual" } });
      await assert.rejects(command(capturedView, { kind: "confirm", accepted: true }), /manual fallback/);
      const done = await command(capturedView, { kind: "confirm", accepted: true, method: "manual" }); assert.equal(done.run.status, "completed");
      const proof = done.run.steps.confirmPresence.output as { method: string; deviceVerified: boolean }; assert.equal(proof.method, "manual"); assert.equal(proof.deviceVerified, false);
    });
    await t.test("publication changes preserve active action pins and capture/confirmation cannot be replaced by literal parameters", async () => {
      const original = copyWorkflowJson(service.WAREHOUSE_PRESENCE_DEFINITION), draft = await publish(original), active = await as(p, () => service.startWorkflow(p, { operationId: op(), definitionId: draft.id }));
      const view = await command(active, { kind: "submit", values: { rawIdentifier: lpn, captureMethod: "manual" } });
      const saved = await as(p, () => service.saveWorkflowDraft(p, { operationId: op(), id: draft.id, expectedRevision: 2, name: "New pinned definition", definition: { ...original, name: "Changed future publication" } }));
      await as(p, () => service.publishWorkflow(p, { operationId: op(), id: draft.id, expectedRevision: saved.revision, note: "Publish independent future revision" }));
      const done = await command(view, { kind: "confirm", accepted: true }); assert.equal(done.run.definitionVersionId, active.run.definitionVersionId); assert.equal(done.run.steps.observe.intent?.actionVersionId, "warehouse-observe-v1");
      const forged = copyWorkflowJson(service.WAREHOUSE_PRESENCE_DEFINITION); forged.steps = forged.steps.filter(step => step.kind !== "confirm");
      const forgedDraft = await publish(forged), forgedRun = await as(p, () => service.startWorkflow(p, { operationId: op(), definitionId: forgedDraft.id }));
      const before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } });
      await assert.rejects(command(forgedRun, { kind: "submit", values: { rawIdentifier: lpn, captureMethod: "manual" } }), /explicit confirmation/);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
    });
    await t.test("identifier changes after lookup roll back the native observation rather than silently switching units", async () => {
      const view = await captured(lpn), before = await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } });
      await owner.warehouseIdentifier.update({ where: { id: primaryAlias.id }, data: { revokedAt: new Date() } }); await alias(1, lpn, "lpn", "wms");
      await assert.rejects(command(view, { kind: "confirm", accepted: true }), /Identifier links changed/);
      assert.equal(await owner.warehousePhysicalObservation.count({ where: { siteId: sites[0].id } }), before);
      const retained = await as(p, () => service.getWorkflowRun(p, { runId: view.run.id })); assert.equal(retained.run.currentStepId, "confirmPresence"); assert.equal(retained.run.steps.observe.intent, undefined);
    });
  } finally { await Promise.all([owner.$disconnect(), prisma.$disconnect()]); }
});
