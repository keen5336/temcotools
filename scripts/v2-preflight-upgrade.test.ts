import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ExcelJS from "exceljs";
import { generate } from "otplib";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal, type SessionClaim } from "../lib/auth/principal";
import { maintenanceClient, maintenanceTarget, tableExists } from "./v2-preflight-support";
import { inspectV2Readiness } from "./v2-preflight";
import { backfillV2Inventory, invalidateRestoredAccess } from "./v2-backfill";
import { bootstrapV2Administrator } from "./v2-bootstrap";
import { withPrincipalSite } from "../lib/sites/context";

const testUrl = process.env.MAINTENANCE_UPGRADE_DATABASE_URL;
const fixturePassword = "Synthetic isolated v1 restoration phrase 84";
const fixtureMfaKey = Buffer.alloc(32, 0x73).toString("base64url");
function upgradeTarget(url: string) {
  const expected = process.env.MAINTENANCE_UPGRADE_DATABASE_NAME ?? "temcotools_v2_upgrade_40_test";
  assert.match(expected, /^temcotools_v2_upgrade(?:_[a-z0-9]+)*_test$/);
  return maintenanceTarget(expected, false, url);
}
test("published v1 migrations and retained fixtures upgrade additively to the qualified v2 migration set", { skip: !testUrl }, async () => {
  const target = upgradeTarget(testUrl!);
  process.env.DATABASE_URL = target.url;
  process.env.SESSION_SECRET = "synthetic-renewed-cutover-session-secret-2026";
  process.env.MFA_ENCRYPTION_KEY = fixtureMfaKey;
  const prisma = maintenanceClient(target);
  const root = process.cwd();
  const scratch = await mkdtemp(join(tmpdir(), "temco-upgrade-"));
  const baseline = join(scratch, "v1"), upgraded = join(scratch, "v2");
  const cutoff = process.env.MAINTENANCE_MIGRATION_CUTOFF ?? "20261103200000";
  assert.match(cutoff, /^\d{14}$/);
  assert.ok(cutoff >= "20261103200000", "The renewed source/custody fixture requires the current custody evidence-serialization migration.");
  const baselineRef = "fea1f22af1b2fae788388f2aefed3e3998e98d09";
  async function configFor(directory: string) {
    const config = join(directory, "prisma.config.mjs");
    // Configure the URL through process environment, never source or stdout.
    await writeFile(config, `const config = ${JSON.stringify({ schema: resolve(root, "prisma/schema.prisma"), migrations: { path: join(directory, "migrations") } })};\nconfig.datasource = {url:process.env.DATABASE_URL};\nexport default config;\n`, "utf8");
    return config;
  }
  function migrate(config: string) {
    execFileSync(process.execPath, [resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", config], { cwd: root, env: { ...process.env, DATABASE_URL: target.url }, stdio: "pipe", timeout: 90_000 });
  }
  try {
    assert.equal(await prisma.$transaction(tx => tableExists(tx, "User")), false, "Refusing a nonempty upgrade database.");
    await mkdir(join(baseline, "migrations"), { recursive: true }); await mkdir(join(upgraded, "migrations"), { recursive: true });
    const legacyNames = execFileSync("git", ["ls-tree", "--name-only", `${baselineRef}:prisma/migrations`], { encoding: "utf8" }).trim().split("\n").filter(name => name !== "migration_lock.toml");
    assert.equal(legacyNames.length, 12);
    for (const name of legacyNames) {
      await mkdir(join(baseline, "migrations", name));
      await writeFile(join(baseline, "migrations", name, "migration.sql"), execFileSync("git", ["show", `${baselineRef}:prisma/migrations/${name}/migration.sql`], { encoding: "utf8" }));
    }
    await copyFile(resolve(root, "prisma/migrations/migration_lock.toml"), join(baseline, "migrations/migration_lock.toml"));
    const currentNames = (await readdir(resolve(root, "prisma/migrations"), { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.slice(0, 14) <= cutoff).map(entry => entry.name).sort();
    if (!process.env.MAINTENANCE_MIGRATION_CUTOFF) {
      const allNames = (await readdir(resolve(root, "prisma/migrations"), { withFileTypes: true })).filter(entry => entry.isDirectory());
      assert.equal(currentNames.length, allNames.length, "The default cutoff no longer includes every current migration. Renew qualification explicitly.");
    }
    for (const name of currentNames) { await mkdir(join(upgraded, "migrations", name)); await copyFile(resolve(root, "prisma/migrations", name, "migration.sql"), join(upgraded, "migrations", name, "migration.sql")); }
    await copyFile(resolve(root, "prisma/migrations/migration_lock.toml"), join(upgraded, "migrations/migration_lock.toml"));
    migrate(await configFor(baseline));
    const [v1Count] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`; assert.equal(Number(v1Count.count), 12);
    await prisma.$executeRaw`INSERT INTO "User" (id,username,"displayName","pinHash",role,"updatedAt","favoriteToolIds") VALUES ('synthetic-v1-admin','synthetic-v1-admin','Synthetic retained administrator','retained-synthetic-pin-hash','admin'::"Role",CURRENT_TIMESTAMP,ARRAY['inventory-audit'])`;
    await prisma.$executeRaw`INSERT INTO "User" (id,username,"displayName","pinHash",role,"updatedAt") VALUES ('synthetic-v1-manager','synthetic-v1-manager','Synthetic retained manager','retained-synthetic-manager-pin','manager'::"Role",CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "InventoryAuditItem" (id,lpn,status,"orderNumber",vendor,"receivedDate",description,"customerName","sourceData","contentHash",revision,"verifiedAt","lastScannedAt","archivedAt") VALUES ('synthetic-v1-item','SYNTHETIC-V1-LPN','Delivered','SYNTHETIC-ORDER','Synthetic vendor','2026-10-01','Synthetic retained appliance','Synthetic recipient','{"syntheticExtraColumn":"retained"}'::jsonb,'synthetic-v1-content',7,'2026-10-22T11:00:00Z','2026-10-22T11:00:00Z','2026-10-23T12:00:00Z')`;
    await prisma.$executeRaw`INSERT INTO "InventoryAuditImport" (id,filename,"uploadedByName","rowCount","insertedCount","changedCount","unchangedCount","duplicateCount","blankCount") VALUES ('synthetic-v1-import','synthetic-v1.xlsx','Synthetic operator',1,1,0,0,0,0)`;
    await prisma.$executeRaw`INSERT INTO "InventoryAuditScan" (id,"sourceScanId","pickWaveId","pickWaveName","scannedValue",lpn,"matchedPickWave","duplicateInWave","scannedAt") VALUES ('synthetic-v1-scan','synthetic-v1-source-scan','synthetic-v1-wave','Synthetic retained wave','SYNTHETIC-V1-LPN','SYNTHETIC-V1-LPN',false,false,'2026-10-22T11:00:00Z')`;
    await prisma.$executeRaw`INSERT INTO "MarsUnit" (id,"requestNumber","orderNumber","serialNumber","requestStatus","updatedAt") VALUES ('synthetic-v1-mars','SYNTHETIC-SUBMISSION','SYNTHETIC-ORDER','SYNTHETIC-SERIAL','Pending',CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "LabelPrinter" (id,name,endpoint,"updatedAt") VALUES ('synthetic-v1-printer','Synthetic retained printer','https://printer.invalid/print',CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "LabelTemplate" (id,name,kind,zpl,"isDefault","updatedAt") VALUES ('synthetic-v1-template','Synthetic retained template','pick_wave'::"LabelTemplateKind",'^XA^FDSynthetic label^FS^XZ',true,CURRENT_TIMESTAMP)`;
    const before = await inspectV2Readiness(prisma); assert.equal(before.identity, null); assert.equal(before.inventory, null); assert.equal(before.migrations.checksumMismatch.length, 0);
    migrate(await configFor(upgraded));
    const state = await inspectV2Readiness(prisma);
    assert.equal(state.migrations.appliedCount, currentNames.length); assert.equal(state.migrations.checksumMismatch.length, 0);
    assert.deepEqual(state.migrations.failed, []); assert.deepEqual(state.migrations.unknownApplied, []);
    if (!process.env.MAINTENANCE_MIGRATION_CUTOFF) assert.deepEqual(state.migrations.pending, []);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: "synthetic-v1-admin" } });
    assert.equal(user.isPlatformAdmin, false, "Legacy admin is not automatically platform authority.");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: "synthetic-v1-manager" } })).isPlatformAdmin, false);
    // Explicit local synthetic fixture authority, not a migration promotion or owner identity change.
    await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
    assert.equal(user.passwordHash, null); assert.equal(user.pinHash, "retained-synthetic-pin-hash"); assert.deepEqual(user.favoriteToolIds, ["inventory-audit"]);
    const manager = await prisma.userRoleBundle.findMany({ where: { userId: "synthetic-v1-manager" }, include: { bundle: true } });
    assert.ok(manager.some(item => item.bundleId === "legacy-manager")); assert.ok(manager.every(item => !item.bundle.capabilities.includes("inventory.identify")));
    const item = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { id: "synthetic-v1-item" } });
    assert.equal(item.unitId, "wms-unit:synthetic-v1-item"); assert.equal(item.revision, 7); assert.ok(item.archivedAt); assert.ok(item.verifiedAt);
    const source = await prisma.inventorySourceRevision.findUniqueOrThrow({ where: { inventoryItemId_revision: { inventoryItemId: item.id, revision: 7 } } });
    assert.deepEqual(source.sourceData, { syntheticExtraColumn: "retained" }); assert.equal(source.migrationSnapshot, true);
    assert.equal(await prisma.inventorySourceRevision.count(), 1, "Older overwritten revisions cannot be invented.");
    assert.equal(await prisma.inventoryImportMembership.count(), 0, "Legacy reports have no fabricated complete membership.");
    assert.equal(await prisma.warehousePhysicalObservation.count(), 0, "Reported stock and legacy scans do not become invented v2 presence.");
    assert.equal(await prisma.inventoryAuditScan.count(), 1); assert.equal(await prisma.marsUnit.count(), 1); assert.equal(await prisma.labelPrinter.count(), 1); assert.equal(await prisma.labelTemplate.count(), 1);
    assert.equal((await prisma.inventoryAuditScan.findUniqueOrThrow({ where: { id: "synthetic-v1-scan" } })).scannedAt.toISOString(), "2026-10-22T11:00:00.000Z");
    assert.equal((await backfillV2Inventory(prisma, { apply: false })).before.missingUnits, 0);
    const dry = await bootstrapV2Administrator(prisma, { username: user.username, create: false, enrollExisting: true, apply: false }); assert.equal(dry.mode, "dry-run");
    const applied = await bootstrapV2Administrator(prisma, { username: user.username, create: false, enrollExisting: true, apply: true, reason: "Synthetic v1 upgrade owner-assisted initial enrollment", deliveryFile: join(scratch, "legacy-admin-enrollment") }); assert.equal(applied.mode, "applied");
    const retained = await prisma.user.findUniqueOrThrow({ where: { id: user.id } }); assert.equal(retained.id, user.id); assert.equal(retained.pinHash, user.pinHash); assert.equal(retained.passwordHash, null);
    assert.equal(await prisma.identityRecoveryToken.count({ where: { userId: user.id, consumedAt: null } }), 1);
    assert.equal(await prisma.marsImportRow.count(), 0, "The migration cannot invent legacy MARS batch membership.");
    assert.equal(await prisma.warehouseUnitNote.count(), 0, "Private legacy notes are not silently copied into public source fixtures.");

    // Populate new native tables through real shared commands for the dump/
    // restore rehearsal. These are synthetic local effects, never network I/O.
    const identity = await import("../lib/auth/identity"), mfa = await import("../lib/auth/mfa");
    const token = (await readFile(join(scratch, "legacy-admin-enrollment"), "utf8")).trim();
    await identity.redeemRecovery({ token, password: fixturePassword }, { source: "synthetic-upgrade39" });
    const login = await identity.signInWithPassword({ username: user.username, password: fixturePassword }, { source: "synthetic-upgrade39" });
    async function actorFor(claim: SessionClaim): Promise<Principal> {
      const actor = await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), "warehouse-initial");
      const session = await prisma.userSession.findUniqueOrThrow({ where: { id: claim.sessionId! } }); assert.ok(actor);
      return { ...actor, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
    }
    let actor = await actorFor(login.claim);
    const factor = await mfa.beginMfaEnrollment(actor, { password: fixturePassword }, { source: "synthetic-upgrade39" });
    await mfa.confirmMfaEnrollment(actor, { token: await generate({ secret: factor.secret }) }, { source: "synthetic-upgrade39" }); actor = await actorFor(login.claim);
    await withPrincipalSite(actor, async () => {
    const payloads = await import("../lib/payloads/service"), sites = await import("../lib/relay-sites/service");
    const adapter = await payloads.createPayload(actor, { id: "synthetic-upgrade39-adapter", name: "Synthetic restore review adapter", purpose: "route_planner_relay", targetOrigins: ["https://synthetic-restore.example.invalid"], source: "globalThis.syntheticRestoreAdapter=true;", protocolVersion: 1, operationNames: [], note: "Synthetic restore draft; no external action" });
    const publishedAdapter = await payloads.publishPayload(actor, { id: adapter.id, expectedRevision: adapter.revision, note: "Synthetic immutable restore publication", reviewedNoSecrets: true });
    await sites.saveSiteProfile(actor, { id: "synthetic-upgrade39-site", name: "Synthetic restore site mapping", origin: "https://synthetic-restore.example.invalid", pathPrefix: "/RP", purpose: "route_planner_relay", payloadId: adapter.id, enabled: true, expectedRevision: null, note: "Synthetic explicit mapping with current real MFA" });
    assert.equal((await sites.resolveSitePayload({ origin: "https://synthetic-restore.example.invalid", pathname: "/RP/day" })).version.id, publishedAdapter.published.id);
    assert.equal(await prisma.siteProfile.count(), 1); assert.equal(await prisma.payloadVersion.count(), 1);
    const notes = await import("../lib/warehouse/notes");
    const note = await notes.appendWarehouseUnitNote(actor, { operationId: "synthetic-upgrade39-note-append", unitId: item.unitId!, body: "Synthetic original unit retained; do not merge it with a replacement." });
    await notes.correctWarehouseUnitNote(actor, { operationId: "synthetic-upgrade39-note-correct", noteId: note.note.noteId, expectedRevision: 1, action: "correct", body: "Synthetic corrected original-unit note; prior text remains history.", reason: "Synthetic correction for restore qualification" });
    const mars = await import("../lib/mars/service"), submissions = await import("../lib/mars/submissions");
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Synthetic restore source");
    sheet.addRow(["Request Number","Order Number","Return Status","Synthetic extra column"]); sheet.addRow(["9900001","SYNTHETIC-NEW-ORDER","Awaiting Pickup","RETAIN THIS SOURCE EXTRA"]);
    await mars.importMarsInventory(actor, { operationId: "synthetic-upgrade39-mars-import", filename: "synthetic-restore.xlsx", scope: "synthetic-restore", coverage: "partial", sourceAsOf: new Date().toISOString(), fileBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64") });
    const audit = await mars.startMarsAudit(actor, { operationId: "synthetic-upgrade39-audit-start", notes: "Synthetic native audit; no upstream action." });
    const scanned = await mars.scanMarsAudit(actor, { operationId: "synthetic-upgrade39-audit-scan", auditSessionId: audit.auditSession.id, scannedValue: "9900001" });
    await mars.completeMarsAudit(actor, { operationId: "synthetic-upgrade39-audit-complete", auditSessionId: audit.auditSession.id });
    await mars.reportMarsAudit(actor, { operationId: "synthetic-upgrade39-audit-report", auditSessionId: audit.auditSession.id, label: "Synthetic immutable pre-void report" });
    await mars.voidMarsAuditScan(actor, { operationId: "synthetic-upgrade39-audit-void", auditSessionId: audit.auditSession.id, scanId: scanned.scanId, reason: "Synthetic audit membership withdrawal; physical evidence remains" });
    const warehouse = await import("../lib/warehouse/units"), office = await import("../lib/office/service");
    const disposition = await office.createOfficeDisposition(actor, { operationId: "synthetic-upgrade39-rtv-authority", unitId: item.unitId!, kind: "rtv", reason: "Synthetic explicit exact-unit authority", instruction: "Human workflow only; no automated submission", expiresAt: new Date(Date.now()+3_600_000).toISOString() });
    await warehouse.recordWarehouseObservation(actor, { eventId: "synthetic-upgrade39-fresh-presence", rawIdentifier: item.lpn, identifierType: "lpn", namespace: "wms", type: "presence", capturedAt: new Date().toISOString(), captureMethod: "manual" });
    const prepared = await submissions.prepareMarsSubmissionIntent(actor, { operationId: "synthetic-upgrade39-intent-prepare", unitId: item.unitId!, authorizationId: disposition.disposition.id, evidence: "Synthetic fresh confirmation of retained physical unit" });
    const started = await submissions.startMarsSubmissionIntent(actor, { operationId: "synthetic-upgrade39-intent-start", intentId: prepared.intent.id, expectedRevision: prepared.intent.revision, evidence: "Synthetic human handoff; no upstream request executed" });
    await submissions.markMarsSubmissionUnknown(actor, { operationId: "synthetic-upgrade39-intent-unknown", intentId: started.intent.id, expectedRevision: started.intent.revision, evidence: "Synthetic unknown-result custody fixture; no request executed" });
    const devices = await import("../lib/labels/devices"), labels = await import("../lib/labels/issuance");
    const device = await devices.registerPrintingDevice(actor, { deviceId: "synthetic-upgrade39-local-device", name: "Synthetic restore phone (no hardware)", mode: "direct", printerIds: ["synthetic-v1-printer"] });
    const label = await labels.prepareLabelIssuance(actor, { operationId: "synthetic-upgrade39-unsent-label", unitId: item.unitId!, printerId: "synthetic-v1-printer", purpose: "legacy_manual", mode: "direct", deviceId: device.device.id, legacyZpl: "^XA^FDSynthetic label^FS^XZ\x04" });
    assert.equal(label.issuance.state, "queued");
    const grants = await import("../lib/application/grants");
    await grants.createAccessGrant(actor, { clientName: "Synthetic restored scoped client", scopes: ["inventory.read"], lifetimeMinutes: 60 });
    assert.equal(await prisma.warehouseUnitNoteRevision.count(), 2); assert.equal(await prisma.marsImportRow.count(), 1); assert.equal(await prisma.marsSubmissionIntent.count({ where: { state: "unknown" } }), 1); assert.equal(await prisma.labelIssuance.count({ where: { state: "queued" } }), 1);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pinHash, user.pinHash);
    const workflows = await import("../lib/workflows/service"), templates = await import("../lib/templates/service"), integrations = await import("../lib/integrations/service"), custody = await import("../lib/warehouse/custody");
    const practice = await workflows.startWorkflow(actor, { operationId: "synthetic-upgrade39-receiving-practice", template: "synthetic_receiving" });
    assert.equal(practice.run.definition.mode, "synthetic"); assert.equal(practice.run.status, "human");
    const selected = await workflows.commandWorkflow(actor, { runId: practice.run.id, expectedRevision: practice.run.revision, definitionVersionId: practice.run.definitionVersionId, commandId: "synthetic-upgrade39-receiving-select", command: { kind: "submit", values: { deliveryId: "SYNTHETIC-INBOUND-001" } } });
    assert.equal(selected.run.currentStepId, "scan"); assert.ok(selected.intents.length > 0);
    const template = await templates.savePlatformTemplate(actor, { operationId: "synthetic-upgrade39-template-draft", expectedRevision: 0, name: "Synthetic restore defaults", payload: { kind: "site_defaults", defaults: { timezone: "America/Chicago", locations: ["SYNTHETIC-RESTORE-LANE"] }, policy: { allowedFields: ["locations"], allowDetach: true } } });
    const published = await templates.publishPlatformTemplate(actor, { operationId: "synthetic-upgrade39-template-publish", id: template.id, expectedRevision: template.revision, note: "Synthetic immutable template restore fixture", reviewedNoPrivateData: true });
    await templates.adoptSiteTemplate(actor, { operationId: "synthetic-upgrade39-template-adopt", id: template.id, versionId: published.version.id, expectedRevision: 0, expectedConsumerRevision: (await prisma.warehouseSite.findUniqueOrThrow({ where: { id: actor.siteId! } })).revision, overrides: {}, note: "Synthetic warehouse defaults restore fixture" });
    const integration = await integrations.saveIntegrationActionDraft(actor, { operationId: "synthetic-upgrade39-integration-draft", expectedRevision: 0, definition: { integrationId: "synthetic-restore", adapterId: "synthetic-http", adapterVersion: 1, origin: "https://synthetic-restore.example.invalid", pagePathPrefix: "/fixture", key: "fixture.identity", name: "Synthetic restore identity contract", effect: "read", requiredCapability: "workflow.read", limits: { timeoutMs: 1000, maxInputBytes: 8192, maxResponseBytes: 65536, maxConcurrent: 1, maxQueued: 3, heartbeatMaxAgeMs: 20000, identityMaxAgeMs: 60000 }, inputs: {}, output: { type: "object", fields: { subject: { type: "string" }, warehouse: { type: "string" } } }, request: { method: "GET", path: "/fixture/identity", query: {} } } });
    const qualified = await integrations.qualifyIntegrationAction(actor, { operationId: "synthetic-upgrade39-integration-qualify", id: integration.id, expectedRevision: integration.revision, qualification: { mode: "synthetic", evidenceReference: "Synthetic restore-only contract; no source request", requestPathPrefix: "/fixture", identityContractId: "synthetic-restore-identity", warehouseBindingContractId: "synthetic-restore-warehouse" } });
    const placeholder = await integrations.registerProviderPlaceholder(actor, { operationId: "synthetic-upgrade39-provider-placeholder", integrationId: "synthetic-restore", deviceId: "synthetic-restore-device", tabId: "synthetic-restore-tab", origin: "https://synthetic-restore.example.invalid", pathname: "/fixture", actionVersionIds: [qualified.version.id] });
    assert.equal(placeholder.provider.transportState, "disconnected");
    const destination = await prisma.warehouseSite.create({ data: { slug: "synthetic-restore-destination", name: "Synthetic restore destination" } });
    const alias = await prisma.warehouseUnitAlias.findFirstOrThrow({ where: { unitId: item.unitId!, kind: "lpn", revokedAt: null } });
    const proposed = await custody.proposeUnitCustody(actor, { operationId: "synthetic-upgrade39-transfer-propose", unitId: item.unitId!, destinationSiteId: destination.id, aliasIds: [alias.id], handoff: { description: "Synthetic unit; expected movement only", handlingInstruction: "No source private notes or execution authority transferred." }, note: "Synthetic restore planned-transfer fixture" });
    const receiver = { ...actor, siteId: destination.id, siteName: destination.name };
    const accepted = await withPrincipalSite(receiver, () => custody.acceptUnitCustody(receiver, { operationId: "synthetic-upgrade39-transfer-accept", transferId: proposed.transfer.id, expectedRevision: proposed.transfer.revision, note: "Synthetic acceptance is not a check-in" }));
    assert.equal(accepted.transfer.state, "accepted"); assert.equal(await prisma.warehouseUnitSite.count({ where: { holdsCustody: true } }), 0);
    assert.equal(await prisma.warehouseUnitTransferEvent.count(), 2); assert.equal(await prisma.workflowRunRecord.count(), 1); assert.equal(await prisma.platformTemplateVersion.count(), 1); assert.equal(await prisma.siteTemplateBinding.count(), 1);
    });
  } finally { await prisma.$disconnect(); if (process.env.DATABASE_URL === target.url) { const { prisma: shared } = await import("../lib/db"); await shared.$disconnect(); } }
});

const restoreUrl = process.env.MAINTENANCE_RESTORE_DATABASE_URL;
test("restored all-40 fixture invalidates old authority without replaying or losing operational evidence", { skip: !restoreUrl }, async () => {
  const expected = process.env.MAINTENANCE_RESTORE_DATABASE_NAME ?? "temcotools_v2_roundtrip_40_test"; assert.match(expected, /^temcotools_v2_roundtrip(?:_[a-z0-9]+)*_test$/);
  const target = maintenanceTarget(expected, false, restoreUrl); const prisma = maintenanceClient(target);
  process.env.DATABASE_URL = target.url; process.env.SESSION_SECRET = "synthetic-renewed-cutover-session-secret-2026"; process.env.MFA_ENCRYPTION_KEY = fixtureMfaKey;
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: "synthetic-v1-admin" }, select: CURRENT_USER_SELECT }); assert.equal(user.username, "synthetic-v1-admin");
    const session = await prisma.userSession.findFirstOrThrow({ where: { userId: user.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
    const claim = { userId: user.id, authVersion: session.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() };
    const resolved = await resolvePrincipal(claim, async () => user, Date.now(), "warehouse-initial"); assert.ok(resolved);
    const actor: Principal = { ...resolved, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
    const identity = await import("../lib/auth/identity"); await prisma.$transaction(tx => identity.assertCurrentPrincipal(tx, actor, "inventory.read"));
    const { decryptMfaSecret } = await import("../lib/auth/mfa-crypto"); const factor = await prisma.userMfa.findUniqueOrThrow({ where: { userId: user.id } });
    const secret = decryptMfaSecret(user.id, factor.encryptedSecret); assert.ok(secret.length > 10); process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x74).toString("base64url"); assert.throws(() => decryptMfaSecret(user.id, factor.encryptedSecret)); process.env.MFA_ENCRYPTION_KEY = fixtureMfaKey;
    const before = { custodyOrigins: await prisma.warehouseUnitOrigin.findMany(), custodySites: await prisma.warehouseUnitSite.findMany(), custodyAliases: await prisma.warehouseUnitAlias.findMany(), custodyVisibility: await prisma.warehouseUnitAliasVisibility.findMany(), transfers: await prisma.warehouseUnitTransfer.findMany(), transferEvents: await prisma.warehouseUnitTransferEvent.findMany(), workflows: await prisma.workflowRunRecord.findMany(), workflowEvents: await prisma.workflowRunEvent.findMany(), workflowIntents: await prisma.workflowIntentRecord.findMany(), templates: await prisma.platformTemplateRecord.findMany(), templateVersions: await prisma.platformTemplateVersion.findMany(), templateBindings: await prisma.siteTemplateBinding.findMany(), integrationActions: await prisma.integrationActionVersion.findMany(), providerConfigurations: await prisma.providerRuntimeConfiguration.findMany(), providerOperations: await prisma.integrationOperation.findMany(), source: await prisma.marsImportRow.findMany(), notes: await prisma.warehouseUnitNoteRevision.findMany(), intents: await prisma.marsSubmissionIntent.findMany(), events: await prisma.marsSubmissionIntentEvent.findMany(), labels: await prisma.labelIssuance.findMany(), observations: await prisma.warehousePhysicalObservation.findMany(), profiles: await prisma.siteProfile.findMany(), payloads: await prisma.payload.findMany(), payloadVersions: await prisma.payloadVersion.findMany(), payloadAudits: await prisma.payloadAudit.findMany() };
    assert.equal(before.profiles.length, 1); assert.equal(before.payloadVersions.length, 1);
    assert.equal(before.intents.filter(intent => intent.state === "unknown").length, 1); assert.equal(before.labels.filter(label => label.state === "queued").length, 1);
    const dry = await invalidateRestoredAccess(prisma, { apply: false }); assert.ok(dry.affected.sessions > 0); assert.ok(dry.affected.clientGrants > 0); assert.ok(dry.affected.mfaRecoveryCodes > 0);
    await invalidateRestoredAccess(prisma, { apply: true, reason: "Synthetic renewed all-40 populated restore invalidation" });
    await assert.rejects(prisma.$transaction(tx => identity.assertCurrentPrincipal(tx, actor, "inventory.read")));
    assert.equal(await prisma.userSession.count({ where: { revokedAt: null } }), 0); assert.equal(await prisma.appAccessGrant.count({ where: { revokedAt: null } }), 0); assert.equal(await prisma.mfaRecoveryCode.count({ where: { consumedAt: null } }), 0);
    assert.equal((await prisma.userMfa.findUniqueOrThrow({ where: { userId: user.id } })).encryptedSecret, factor.encryptedSecret);
    const after = { custodyOrigins: await prisma.warehouseUnitOrigin.findMany(), custodySites: await prisma.warehouseUnitSite.findMany(), custodyAliases: await prisma.warehouseUnitAlias.findMany(), custodyVisibility: await prisma.warehouseUnitAliasVisibility.findMany(), transfers: await prisma.warehouseUnitTransfer.findMany(), transferEvents: await prisma.warehouseUnitTransferEvent.findMany(), workflows: await prisma.workflowRunRecord.findMany(), workflowEvents: await prisma.workflowRunEvent.findMany(), workflowIntents: await prisma.workflowIntentRecord.findMany(), templates: await prisma.platformTemplateRecord.findMany(), templateVersions: await prisma.platformTemplateVersion.findMany(), templateBindings: await prisma.siteTemplateBinding.findMany(), integrationActions: await prisma.integrationActionVersion.findMany(), providerConfigurations: await prisma.providerRuntimeConfiguration.findMany(), providerOperations: await prisma.integrationOperation.findMany(), source: await prisma.marsImportRow.findMany(), notes: await prisma.warehouseUnitNoteRevision.findMany(), intents: await prisma.marsSubmissionIntent.findMany(), events: await prisma.marsSubmissionIntentEvent.findMany(), labels: await prisma.labelIssuance.findMany(), observations: await prisma.warehousePhysicalObservation.findMany(), profiles: await prisma.siteProfile.findMany(), payloads: await prisma.payload.findMany(), payloadVersions: await prisma.payloadVersion.findMany(), payloadAudits: await prisma.payloadAudit.findMany() }; assert.deepEqual(after,before);
    const signIn = await identity.signInWithPassword({ username: user.username, password: fixturePassword }, { source: "synthetic-renewed-restore" }); assert.notEqual(signIn.claim.sessionId, session.id);
    assert.equal((await prisma.userSession.findUniqueOrThrow({ where: { id: signIn.claim.sessionId! } })).mfaVerifiedAt, null, "Restoration/sign-in cannot recreate privileged MFA proof.");
    const state = await inspectV2Readiness(prisma); assert.equal(state.migrations.appliedCount,40); assert.deepEqual(state.migrations.checksumMismatch,[]); assert.deepEqual(state.migrations.pending,[]);
  } finally { await prisma.$disconnect(); const { prisma: shared } = await import("../lib/db"); await shared.$disconnect(); }
});
