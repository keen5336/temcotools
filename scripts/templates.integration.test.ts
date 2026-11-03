import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withPrincipalSite } from "../lib/sites/context";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import { validatePlatformTemplate } from "../lib/templates/model";

const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("platform templates materialize authorized warehouse consumers with protected pins", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  process.env.DATABASE_URL = url; process.env.TEMCO_PILOT_MODE = "read_only_dmp";
  const [{ prisma }, templates, workflows, labels, configuration, sites] = await Promise.all([import("../lib/db"), import("../lib/templates/service"), import("../lib/workflows/service"), import("../lib/labels/workflows"), import("../lib/label-configuration-service"), import("../lib/sites/service")]);
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID(), at = new Date();
  const warehouses = await Promise.all(["a", "b"].map(name => owner.warehouseSite.create({ data: { slug: `template-${ns}-${name}`, name: `Synthetic template ${name}` } })));
  const users = await Promise.all([true, false].map((isPlatformAdmin, index) => owner.user.create({ data: { username: `template-${ns}-${index}`, displayName: "Synthetic template person", role: "admin", isPlatformAdmin, pinHash: "disabled:v2", passwordHash: "synthetic-nonlogin-value" } })));
  await Promise.all(warehouses.map(site => owner.warehouseMembership.create({ data: { siteId: site.id, userId: users[1].id, roles: { create: { roleId: "warehouse-manager" } } } })));
  const sessions = await Promise.all(users.map(user => owner.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: 1, activeSiteId: warehouses[0].id, expiresAt: new Date(at.getTime() + 3600_000), lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, deviceLabel: "Synthetic template test" } })));
  async function principal(index: number, siteId = warehouses[0].id): Promise<Principal> { const session = sessions[index], p = await resolvePrincipal({ userId: session.userId, authVersion: 1, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), siteId); assert.ok(p); return { ...p, sessionId: session.id }; }
  const admin = await principal(0), manager = await principal(1), managerB = await principal(1, warehouses[1].id), as = <T>(p: Principal, fn: () => T) => withPrincipalSite(p, fn), op = () => randomUUID();
  const workflowPayload = { kind: "workflow", definition: { id: "global-form", versionId: "global-form-v1", version: 1, configurationVersion: "workflow-local-config-v1", name: "Published synthetic form", mode: "synthetic", steps: [{ id: "entry", kind: "form", title: "Enter synthetic value", saveAs: "entry", fields: [{ key: "value", label: "Synthetic value", type: "identifier" }] }, { id: "echo", kind: "action", title: "Local result", action: { id: "workflow.local.echo", versionId: "workflow-local-echo-v1", configurationVersion: "workflow-local-config-v1", capability: "workflow.read", effect: "local" }, parameters: { value: { source: "data", path: ["entry", "value"] } } }] }, policy: { allowedFields: ["name", "stepText"], allowDetach: false } };
  const labelPayload = { kind: "label_workflow", definition: { purpose: "unit_identity", name: "Platform identity label", zpl: "^XA^FO10,10^FD{{lpn}}^FS^XZ", requiredFields: ["lpn"], rules: [{ id: "manual", name: "Manual default", class: "default", priority: 1, enabled: true, automatic: false, conditions: [] }], widthMm: 102, heightMm: 76, dpi: 203 }, policy: { allowedFields: ["name", "zpl"], allowDetach: false } };
  async function publish(name: string, payload: unknown) { const draft = await as(admin, () => templates.savePlatformTemplate(admin, { operationId: op(), expectedRevision: 0, name, payload })); const result = await as(admin, () => templates.publishPlatformTemplate(admin, { operationId: op(), id: draft.id, expectedRevision: draft.revision, note: "Synthetic reviewed platform defaults", reviewedNoPrivateData: true })); return result; }
  type Binding = Awaited<ReturnType<typeof templates.adoptSiteTemplate>>;
  const consumer = (binding: Binding) => binding.materialized as { workflowId?: string; workflowVersionId?: string; labelVersionId?: string; consumerRevision: number };
  let workflowSource: Awaited<ReturnType<typeof publish>>, a: Binding, b: Binding;
  try {
    await t.test("only current platform authority/fresh MFA can publish; versions and source IDs are protected", async () => {
      await assert.rejects(as(manager, () => templates.savePlatformTemplate(manager, { operationId: op(), expectedRevision: 0, name: "Forbidden", payload: workflowPayload })), /permission/);
      workflowSource = await publish("Published platform workflow", workflowPayload);
      assert.equal((await as(manager, () => prisma.platformTemplateRecord.updateMany({ where: { id: workflowSource.record.id }, data: { name: "Forbidden raw update" } }))).count, 0);
      await assert.rejects(owner.platformTemplateVersion.update({ where: { id: workflowSource.version.id }, data: { contentHash: "changed" } }), /immutable/);
      await owner.userSession.update({ where: { id: sessions[0].id }, data: { mfaVerifiedAt: null } });
      await assert.rejects(as(admin, () => templates.savePlatformTemplate(admin, { operationId: op(), expectedRevision: 0, name: "Expired MFA", payload: workflowPayload })), /authenticator/);
      await owner.userSession.update({ where: { id: sessions[0].id }, data: { mfaVerifiedAt: at } });
      for (const injected of [{ ...workflowPayload, providerId: "private-provider" }, { ...workflowPayload, cookie: "session-data" }, { ...workflowPayload, deviceId: "private-device" }]) assert.throws(() => validatePlatformTemplate(injected), /private people|credentials/);
      assert.throws(() => validatePlatformTemplate({ ...workflowPayload, title: "Bearer synthetic-credential-material" }), /credentials/);
    });
    await t.test("site copies apply allowed overrides and actual generic workflow starts from the materialized version", async () => {
      a = await as(manager, () => templates.adoptSiteTemplate(manager, { operationId: op(), id: workflowSource.record.id, versionId: workflowSource.version.id, expectedRevision: 0, overrides: { name: "Warehouse A form", stepText: { entry: { title: "Warehouse A capture" } } }, note: "Adopt warehouse A form" }));
      b = await as(managerB, () => templates.adoptSiteTemplate(managerB, { operationId: op(), id: workflowSource.record.id, versionId: workflowSource.version.id, expectedRevision: 0, overrides: { name: "Warehouse B form" }, note: "Adopt warehouse B form" }));
      assert.notEqual(consumer(a).workflowId, consumer(b).workflowId);
      const started = await as(manager, () => workflows.startWorkflow(manager, { operationId: op(), definitionId: consumer(a).workflowId })); assert.equal(started.run.definition.name, "Warehouse A form"); assert.equal(started.run.definition.steps[0].title, "Warehouse A capture");
      await assert.rejects(as(managerB, () => workflows.startWorkflow(managerB, { operationId: op(), definitionId: consumer(a).workflowId })), /published/);
      const before = await owner.workflowDefinitionRecord.findUniqueOrThrow({ where: { id: consumer(a).workflowId } });
      await assert.rejects(as(manager, () => workflows.saveWorkflowDraft(manager, { operationId: op(), id: before.id, expectedRevision: before.revision, name: "Bypass", definition: workflowPayload.definition })), /allowed site overrides/);
      await assert.rejects(as(manager, () => templates.previewSiteTemplate(manager, { id: workflowSource.record.id, versionId: workflowSource.version.id, overrides: { definition: { mode: "live" } } })), /Unrecognized/);
      await assert.rejects(as(manager, () => templates.detachSiteTemplate(manager, { operationId: op(), id: a.id, expectedRevision: a.revision, note: "Local cannot detach protected source" })), /cannot be detached/);
    });
    await t.test("new platform publication and local adoption keep old run snapshots intact; drafts remain private", async () => {
      const old = await as(manager, () => workflows.startWorkflow(manager, { operationId: op(), definitionId: consumer(a).workflowId }));
      const updated = await as(admin, () => templates.savePlatformTemplate(admin, { operationId: op(), id: workflowSource.record.id, expectedRevision: workflowSource.record.revision, name: "UNPUBLISHED-SYNTHETIC-NAME", payload: { ...workflowPayload, definition: { ...workflowPayload.definition, name: "UNPUBLISHED-SYNTHETIC-SOURCE" } } }));
      const local = await as(manager, () => templates.getPlatformTemplate(manager, { id: workflowSource.record.id })); assert.equal(local.draft, null); assert.equal(local.name, "Published platform workflow"); assert.equal(JSON.stringify(local).includes("UNPUBLISHED-SYNTHETIC"), false);
      const visible = await as(manager, () => templates.listPlatformTemplates(manager, {})); assert.equal(visible.templates.find(item => item.id === workflowSource.record.id)?.name, "Published platform workflow");
      const published = await as(admin, () => templates.publishPlatformTemplate(admin, { operationId: op(), id: updated.id, expectedRevision: updated.revision, note: "Publish reviewed version two", reviewedNoPrivateData: true }));
      const next = await as(manager, () => templates.adoptSiteTemplate(manager, { operationId: op(), id: published.record.id, versionId: published.version.id, expectedRevision: a.revision, expectedConsumerRevision: consumer(a).consumerRevision, overrides: { name: "Warehouse A v2" }, note: "Adopt reviewed version two" }));
      const retained = await as(manager, () => workflows.getWorkflowRun(manager, { runId: old.run.id })); assert.equal(retained.run.definitionVersionId, old.run.definitionVersionId); assert.equal(retained.run.definition.name, "Warehouse A form");
      const current = await as(manager, () => workflows.startWorkflow(manager, { operationId: op(), definitionId: consumer(next).workflowId })); assert.equal(current.run.definition.name, "Warehouse A v2"); assert.notEqual(current.run.definitionVersionId, old.run.definitionVersionId);
      await assert.rejects(as(manager, () => templates.adoptSiteTemplate(manager, { operationId: op(), id: published.record.id, versionId: published.version.id, expectedRevision: a.revision, overrides: {}, note: "Stale binding revision" })), /override changed/);
    });
    await t.test("label template overrides feed native label consumers while protected rules/purpose cannot drift", async () => {
      const source = await publish("Platform identity label", labelPayload);
      const adopted = await as(manager, () => templates.adoptSiteTemplate(manager, { operationId: op(), id: source.record.id, versionId: source.version.id, expectedRevision: 0, overrides: { name: "Warehouse A identity", zpl: "^XA^FO20,20^FD{{lpn}}^FS^XZ" }, note: "Adopt local label rendering" }));
      const current = await as(manager, () => labels.getLabelWorkflow(manager, "unit_identity")); assert.equal(current.publishedVersionId, consumer(adopted).labelVersionId); assert.match(current.publishedVersion?.zpl ?? "", /FO20,20/); assert.deepEqual(current.requiredFields, ["lpn"]);
      await assert.rejects(as(manager, () => labels.saveLabelWorkflow(manager, { ...labelPayload.definition, name: "Bypass", expectedRevision: current.revision, note: "Attempt protected local write" })), /allowed site overrides/);
      await assert.rejects(as(manager, () => templates.previewSiteTemplate(manager, { id: source.record.id, versionId: source.version.id, overrides: { dpi: 300 } })), /protected/);
    });
    await t.test("warehouse defaults resolve only local managed printers and flow into actual configuration/scanner consumers", async () => {
      const printers = await Promise.all(warehouses.map((site, index) => owner.labelPrinter.create({ data: { siteId: site.id, name: "Warehouse label printer", endpoint: `http://synthetic-${index}.fakeprinter.invalid/queue` } })));
      const payload = { kind: "site_defaults", defaults: { timezone: "UTC", locations: ["SYNTHETIC-RECEIVING"], printerName: "Warehouse label printer", connectionRules: [{ integrationId: "synthetic-wms", purpose: "read", selection: "explicit_authorized_provider" }] }, policy: { allowedFields: ["timezone", "locations", "defaultPrinterId"], allowDetach: false } };
      const source = await publish("Warehouse defaults", payload);
      await as(manager, () => templates.adoptSiteTemplate(manager, { operationId: op(), id: source.record.id, versionId: source.version.id, expectedRevision: 0, expectedConsumerRevision: 1, overrides: { timezone: "America/Chicago", locations: ["SYNTHETIC-A"] }, note: "Adopt warehouse A locations" }));
      await as(managerB, () => templates.adoptSiteTemplate(managerB, { operationId: op(), id: source.record.id, versionId: source.version.id, expectedRevision: 0, expectedConsumerRevision: 1, overrides: { timezone: "Europe/London", locations: ["SYNTHETIC-B"] }, note: "Adopt warehouse B locations" }));
      const aDefaults = await as(manager, () => prisma.$transaction(tx => templates.getTemplateSelectionDefaults(tx, manager))), bDefaults = await as(managerB, () => prisma.$transaction(tx => templates.getTemplateSelectionDefaults(tx, managerB)));
      assert.equal(aDefaults.defaultPrinterId, printers[0].id); assert.equal(bDefaults.defaultPrinterId, printers[1].id); assert.deepEqual(aDefaults.locations, ["SYNTHETIC-A"]); assert.deepEqual(bDefaults.locations, ["SYNTHETIC-B"]); assert.equal(aDefaults.createsAuthority, false); assert.equal(aDefaults.automaticFailover, false);
      const native = await as(manager, () => configuration.getOperatorLabelConfiguration(manager, { kind: "pick_wave" })); assert.equal(native.printers[0].id, printers[0].id); assert.equal(native.defaults.defaultPrinterId, printers[0].id);
      const adminView = await as(manager, () => sites.getSiteAdministration(manager)); assert.equal((adminView.site.configuration as { timezone: string }).timezone, "America/Chicago");
      await assert.rejects(as(manager, () => sites.saveSiteConfiguration(manager, { operationId: op(), expectedRevision: adminView.site.revision, name: "Synthetic current site", configuration: { ...(adminView.site.configuration as object), timezone: "UTC" } })), /protected platform defaults/);
      const binding = (await as(manager, () => templates.listPlatformTemplates(manager, {}))).bindings.find(item => item.templateId === source.record.id)!;
      await assert.rejects(as(manager, () => templates.adoptSiteTemplate(manager, { operationId: op(), id: source.record.id, versionId: source.version.id, expectedRevision: binding.revision, expectedConsumerRevision: adminView.site.revision, overrides: { defaultPrinterId: printers[1].id }, note: "Cross warehouse must be denied" })), /this warehouse/);
      assert.equal(await owner.providerAccessGrant.count({ where: { siteId: warehouses[0].id } }), 0); assert.equal(await owner.printingDevice.count({ where: { siteId: warehouses[0].id } }), 0);
    });
    await t.test("concurrent adoption and native label editing never overwrite inherited protected materialization", async () => {
      const source = await publish("Concurrent label default", { ...labelPayload, definition: { ...labelPayload.definition, purpose: "put_away", name: "Concurrent synthetic label" } });
      await as(manager, () => labels.saveLabelWorkflow(manager, { ...labelPayload.definition, purpose: "put_away", expectedRevision: 0, note: "Create pre-existing local label" }));
      const input = { operationId: op(), id: source.record.id, versionId: source.version.id, expectedRevision: 0, expectedConsumerRevision: 1, replaceExisting: true, overrides: {}, note: "Explicitly adopt concurrent label" };
      await Promise.allSettled([as(manager, () => templates.adoptSiteTemplate(manager, input)), as(manager, () => labels.saveLabelWorkflow(manager, { ...labelPayload.definition, purpose: "put_away", name: "Concurrent native edit", expectedRevision: 1, note: "Native edit racing adoption" }))]);
      const binding = await owner.siteTemplateBinding.findFirst({ where: { siteId: warehouses[0].id, templateId: source.record.id, enabled: true } }), current = await owner.labelWorkflow.findFirstOrThrow({ where: { siteId: warehouses[0].id, purpose: "put_away" } });
      if (binding) { assert.equal(current.publishedVersionId, (binding.materialized as { labelVersionId: string }).labelVersionId); assert.equal(current.name, "Concurrent synthetic label"); }
      else assert.equal(current.name, "Concurrent native edit");
    });
    await t.test("membership revocation and local binding revision checks apply without altering login identity", async () => {
      const original = await owner.user.findUniqueOrThrow({ where: { id: users[1].id } });
      await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: warehouses[0].id, userId: users[1].id } }, data: { isActive: false } });
      await assert.rejects(as(manager, () => templates.listPlatformTemplates(manager, {})), /warehouse access/);
      const after = await owner.user.findUniqueOrThrow({ where: { id: users[1].id } }); assert.equal(after.passwordHash, original.passwordHash); assert.equal(after.authVersion, original.authVersion);
    });
  } finally { await Promise.all([owner.$disconnect(), prisma.$disconnect()]); }
});
