import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";
import { generate } from "otplib";
import { hashPassword } from "../lib/auth/passwords";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal, type SessionClaim } from "../lib/auth/principal";
import { maintenanceClient, maintenanceTarget } from "./v2-preflight-support";

const testUrl = process.env.MARS_TEST_DATABASE_URL;
test("retained MARS commands, immutable source history and exact-unit human submission custody", { skip: !testUrl }, async suite => {
  const databaseName = new URL(testUrl!).pathname.slice(1);
  assert.match(databaseName, /^temcotools_v2_mars(?:_[a-z0-9]+)*_test$/, "Use an explicitly named task-owned synthetic MARS database.");
  const target = maintenanceTarget(databaseName, false, testUrl);
  process.env.DATABASE_URL = target.url; process.env.SESSION_SECRET = "synthetic-mars-test-current-session-secret-2026"; process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x71).toString("base64url");
  const prisma = maintenanceClient(target);
  assert.equal(await prisma.user.count(), 0, "Use a fresh dedicated synthetic MARS database; fixtures and immutable evidence are retained.");
  const identity = await import("../lib/auth/identity"), mfa = await import("../lib/auth/mfa"), mars = await import("../lib/mars/service"), submissions = await import("../lib/mars/submissions"), office = await import("../lib/office/service"), warehouse = await import("../lib/warehouse/units"), grants = await import("../lib/application/grants");
  const prefix = `MARS-${randomUUID()}`, password = "Synthetic private MARS warehouse phrase 78";
  const op = (name: string) => `${name}:${randomUUID()}`;
  async function principalFor(claim: SessionClaim): Promise<Principal> {
    const principal = await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    const session = await prisma.userSession.findUniqueOrThrow({ where: { id: claim.sessionId! } }); assert.ok(principal);
    return { ...principal, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
  }
  async function person(suffix: string, role: "admin" | "user") {
    const user = await prisma.user.create({ data: { username: `${prefix}-${suffix}`, displayName: "Synthetic MARS operator", role, pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: `legacy-${role}` } } } });
    const login = await identity.signInWithPassword({ username: user.username, password }, { source: prefix }); return { user, claim: login.claim, principal: await principalFor(login.claim) };
  }
  async function workbook(rows: Array<Array<string>>) {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Synthetic returns"); sheet.addRow(["Request Number","Order Number","Serial Number","Return Status","Extra synthetic source column"]); for (const row of rows) sheet.addRow(row);
    return Buffer.from(await book.xlsx.writeBuffer()).toString("base64");
  }
  try {
    const admin = await person("admin", "admin"), operator = await person("operator", "user"), other = await person("other", "user");
    const setup = await mfa.beginMfaEnrollment(admin.principal, { password }, { source: prefix }); await mfa.confirmMfaEnrollment(admin.principal, { token: await generate({ secret: setup.secret }) }, { source: prefix }); admin.principal = await principalFor(admin.claim);
    const A = await warehouse.createWarehouseUnit(admin.principal, { operationId: op("unit-A"), evidence: "Synthetic original appliance A; order is context only." });
    const B = await warehouse.createWarehouseUnit(admin.principal, { operationId: op("unit-B"), evidence: "Synthetic replacement appliance B; distinct physical identity." });
    await warehouse.linkWarehouseIdentifier(admin.principal, { unitId: A.unitId, kind: "lpn", namespace: "wms", value: `${prefix}-A`, evidence: "Synthetic original LPN evidence" });
    await warehouse.linkWarehouseIdentifier(admin.principal, { unitId: B.unitId, kind: "lpn", namespace: "wms", value: `${prefix}-B`, evidence: "Synthetic replacement LPN evidence" });
    let firstBatch = "", auditId = "", savedPayload: unknown;
    await suite.test("partial/complete imports preserve full immutable rows, exact scope and old snapshots without external deletion", async () => {
      const input = { operationId: op("import-alpha"), filename: "synthetic-alpha.xlsx", scope: "synthetic-alpha", coverage: "partial", sourceAsOf: new Date(Date.now()-6000).toISOString(), fileBase64: await workbook([["7000001","SYNTHETIC-SHARED-ORDER","SYNTHETIC-A","Awaiting Pickup","SOURCE-A"],["7000003","SYNTHETIC-SHARED-ORDER","SYNTHETIC-C","Awaiting Pickup","SOURCE-C"],["7000003","SYNTHETIC-SHARED-ORDER","SYNTHETIC-C","Awaiting Pickup","SOURCE-C-last"]]) };
      const first = await mars.importMarsInventory(admin.principal, input); firstBatch = first.batchId;
      assert.equal((await mars.importMarsInventory(admin.principal, input)).replayed, true); assert.equal(await prisma.marsImportBatch.count(), 1);
      assert.equal(await prisma.marsImportRow.count({ where: { batchId: firstBatch } }), 3);
      const source = await prisma.marsImportRow.findFirstOrThrow({ where: { batchId: firstBatch, rowNumber: 2 } }); assert.ok(JSON.stringify(source.sourceData).includes("SOURCE-A"));
      await assert.rejects(prisma.marsImportRow.update({ where: { id: source.id }, data: { contentHash: "forged" } }));
      await assert.rejects(mars.importMarsInventory(admin.principal, { ...input, filename: "different.xlsx" }), /different MARS work/);
      await mars.importMarsInventory(admin.principal, { operationId: op("import-beta"), filename: "synthetic-beta.xlsx", scope: "synthetic-beta", coverage: "partial", sourceAsOf: new Date(Date.now()-4000).toISOString(), fileBase64: await workbook([["7000002","SYNTHETIC-SHARED-ORDER","SYNTHETIC-B","Awaiting Pickup","SOURCE-B"]]) });
      await assert.rejects(mars.importMarsInventory(admin.principal, { operationId: op("no-evidence"), filename: "synthetic.xlsx", scope: "synthetic-alpha", coverage: "complete", fileBase64: await workbook([]) }), /Complete coverage requires/);
      await mars.importMarsInventory(admin.principal, { operationId: op("complete-alpha"), filename: "synthetic-complete-alpha.xlsx", scope: "synthetic-alpha", coverage: "complete", coverageEvidence: "Synthetic full export filtered to alpha only", sourceAsOf: new Date(Date.now()-2000).toISOString(), fileBase64: await workbook([["7000001","SYNTHETIC-SHARED-ORDER","SYNTHETIC-A","Awaiting Pickup","SOURCE-A-new"]]) });
      const omitted = await prisma.marsUnit.findUniqueOrThrow({ where: { requestNumber: "7000003" } }); assert.equal(omitted.presentInLatestImport, false); assert.equal(omitted.localStatus, "active"); assert.equal(omitted.archivedAt, null);
      assert.equal((await prisma.marsUnit.findUniqueOrThrow({ where: { requestNumber: "7000002" } })).presentInLatestImport, true);
      const { getMarsBatchSnapshot } = await import("../lib/mars/snapshots"); const old = await getMarsBatchSnapshot(prisma, firstBatch); assert.equal(old.units.length, 2); assert.ok(old.units.some(unit => unit.requestNumber === "7000003"));
      assert.equal(await prisma.warehouseIdentifier.count({ where: { kind: "submission" } }), 0, "Shared order context never merges units or creates aliases.");
    });
    await suite.test("read scopes/current revocation deny mutations and operator fields cannot forge attribution", async () => {
      const grant = await grants.createAccessGrant(admin.principal, { clientName: "Synthetic MARS reader", scopes: ["workflow.read"], lifetimeMinutes: 5 }); const reader = await grants.authenticateAccessGrant(grant.token);
      assert.ok((await mars.listMarsInventory(reader, { limit: 10, archived: null, returnStatusMode: "all" })).items.length > 0);
      await assert.rejects(mars.startMarsAudit(reader, { operationId: op("denied") }));
      await assert.rejects(mars.startMarsAudit(operator.principal, { operationId: op("forged"), userId: admin.user.id }));
      await prisma.user.update({ where: { id: other.user.id }, data: { isActive: false, authVersion: { increment: 1 } } }); await assert.rejects(mars.listMarsInventory(other.principal));
    });
    await suite.test("retained stage/archive/audit/report/sighting actions share current writers and preserve evidence", async () => {
      const staged = await mars.stageMarsSubmission(operator.principal, { operationId: op("stage"), requestNumber: "7000001", staged: true }); assert.equal(staged.unit?.staged, true);
      await mars.archiveMarsSubmission(operator.principal, { operationId: op("archive"), requestNumber: "7000001", archived: true, reason: "Synthetic local archive only" }); assert.ok((await mars.getMarsSubmission(operator.principal, { requestNumber: "7000001" }))?.archivedAt);
      await mars.archiveMarsSubmission(operator.principal, { operationId: op("unarchive"), requestNumber: "7000001", archived: false });
      auditId = (await mars.startMarsAudit(operator.principal, { operationId: op("audit-start"), notes: "Synthetic current audit" })).auditSession.id;
      const input = { operationId: op("scan"), auditSessionId: auditId, scannedValue: "7000001" }; const first = await mars.scanMarsAudit(operator.principal, input); assert.equal(first.matched, true); assert.equal((await mars.scanMarsAudit(operator.principal, input)).replayed, true);
      const unknown = await mars.scanMarsAudit(operator.principal, { operationId: op("unknown"), auditSessionId: auditId, scannedValue: "SYNTHETIC-UNKNOWN" }); assert.equal(unknown.matched, false);
      assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: operator.user.id } }), 2); assert.equal(await prisma.warehousePhysicalObservation.count({ where: { unitId: null, resolution: "unresolved" } }), 2);
      await mars.completeMarsAudit(operator.principal, { operationId: op("complete"), auditSessionId: auditId }); await assert.rejects(mars.scanMarsAudit(operator.principal, { operationId: op("late-scan"), auditSessionId: auditId, scannedValue: "7000001" }), /already completed/);
      const saved = await mars.reportMarsAudit(operator.principal, { operationId: op("report"), auditSessionId: auditId, label: "Synthetic saved version" }); savedPayload = saved.payload;
      const pinned = (await mars.getMarsAudit(operator.principal, { auditSessionId: auditId }))!.currentReport;
      await mars.importMarsInventory(admin.principal, { operationId: op("later-refresh"), filename: "synthetic-later.xlsx", scope: "synthetic-alpha", coverage: "partial", sourceAsOf: new Date().toISOString(), fileBase64: await workbook([["7000001","SYNTHETIC-SHARED-ORDER","SYNTHETIC-A","Shipped","LATER-SOURCE"]]) });
      assert.deepEqual((await mars.getMarsAudit(operator.principal, { auditSessionId: auditId }))!.currentReport, pinned, "Later imports cannot replace the audit's immutable pinned source membership/status.");
      await mars.voidMarsAuditScan(operator.principal, { operationId: op("void"), auditSessionId: auditId, scanId: unknown.scanId, reason: "Synthetic audit membership correction" });
      assert.equal(await prisma.marsAuditScan.count({ where: { id: unknown.scanId } }), 1); assert.ok((await prisma.marsAuditScan.findUniqueOrThrow({ where: { id: unknown.scanId } })).voidedAt); assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: operator.user.id } }), 2);
      const amended = await mars.amendMarsAudit(operator.principal, { operationId: op("amend"), auditSessionId: auditId, scannedValue: "7000002", manualEntry: true }); assert.equal(amended.detail?.scans.length, 2);
      const disputed = await Promise.all([A.unitId,B.unitId].map(unitId => warehouse.linkWarehouseIdentifier(admin.principal, { unitId, kind: "submission", namespace: "mars", value: "7000088", evidence: "Synthetic disputed submission identity requiring review" })));
      const ambiguous = await mars.amendMarsAudit(operator.principal, { operationId: op("ambiguous"), auditSessionId: auditId, scannedValue: "7000088", manualEntry: true });
      const scan = await prisma.marsAuditScan.findUniqueOrThrow({ where: { id: ambiguous.id } }); const physical = await prisma.warehousePhysicalObservation.findUniqueOrThrow({ where: { id: scan.warehouseObservationId! } }); assert.equal(physical.resolution, "ambiguous"); assert.equal(physical.unitId, null); assert.equal((physical.candidateUnitIds as string[]).length, 2);
      for (const alias of disputed) await warehouse.unlinkWarehouseIdentifier(admin.principal, { identifierId: alias.identifierId, reason: "Synthetic review withdraws disputed alias without erasing history" });
      const sighting = await mars.sightMarsSubmission(operator.principal, { operationId: op("sighting"), requestNumber: "NOT-YET-IMPORTED" }); assert.equal(sighting.unit, null); assert.equal(sighting.warehouseObservation.resolution, "unresolved");
      const detail = await mars.getMarsAudit(operator.principal, { auditSessionId: auditId }); assert.equal(detail?.voidedScans.length, 1); assert.deepEqual(detail?.savedReports[0].payload, savedPayload);
      assert.ok((await mars.getMarsAudits(operator.principal)).length); assert.ok((await mars.getMarsImports(operator.principal)).length); assert.ok((await mars.getMarsBuckets(operator.principal)).length); await mars.getMarsOverview(operator.principal); await mars.reconcileMarsInventory(operator.principal);
    });
    await suite.test("buffered captures retain actor/session/time, while unsigned legacy history never becomes physical presence", async () => {
      const before = await prisma.warehousePhysicalObservation.count(); const at = new Date().toISOString();
      const input = { operationId: op("buffer"), localAuditId: op("draft"), deviceId: "SYNTHETIC-ZEBRA", startedAt: at, completedAt: at, scans: [{ value: "7000001", scannedAt: at, eventId: op("event"), capturedByUserId: operator.user.id, captureSessionId: operator.claim.sessionId!, captureMethod: "scanner" as const }] };
      const uploaded = await mars.submitMarsAudit(operator.principal, input); assert.equal((await mars.submitMarsAudit(operator.principal, input)).replayed, true); assert.equal(await prisma.warehousePhysicalObservation.count(), before + 1);
      const scan = await prisma.marsAuditScan.findFirstOrThrow({ where: { auditSessionId: uploaded.session.id } }); assert.equal(scan.capturedAt?.toISOString(), at); assert.equal(scan.userId, operator.user.id); assert.equal(scan.captureSessionId, operator.claim.sessionId); assert.ok(scan.warehouseObservationId);
      await assert.rejects(mars.submitMarsAudit(operator.principal, { ...input, operationId: op("bad-captor"), localAuditId: op("bad-draft"), scans: [{ ...input.scans[0], capturedByUserId: admin.user.id }] }), /original user/);
      const legacy = await mars.submitMarsAudit(operator.principal, { operationId: op("legacy"), localAuditId: op("legacy-draft"), deviceId: "SYNTHETIC-OLD-DEVICE", scans: [{ value: "7000001", scannedAt: "2026-10-01T12:00:00Z", legacyUnassigned: true }] });
      const unsigned = await prisma.marsAuditScan.findFirstOrThrow({ where: { auditSessionId: legacy.session.id } }); assert.equal(unsigned.userId, null); assert.equal(unsigned.captureProvenance, "legacy_unassigned"); assert.equal(unsigned.warehouseObservationId, null); assert.equal(await prisma.warehousePhysicalObservation.count(), before + 1);
      assert.match((await mars.getMarsAudit(operator.principal, { auditSessionId: legacy.session.id }))!.currentReport.physicalEvidenceQualification!, /unsigned/);
    });
    await suite.test("exact A/B authority, concurrent preparation, one handoff and unknown-no-replay reconciliation", async () => {
      const disposition = await office.createOfficeDisposition(admin.principal, { operationId: op("authorize-A"), unitId: A.unitId, kind: "rtv", reason: "Synthetic original requires RTV", instruction: "Return only original A, never replacement B", expiresAt: new Date(Date.now()+3600000).toISOString() });
      await warehouse.recordWarehouseObservation(operator.principal, { eventId: op("checkin-A"), rawIdentifier: `${prefix}-A`, identifierType: "lpn", namespace: "wms", type: "check_in", capturedAt: new Date().toISOString() });
      await assert.rejects(submissions.prepareMarsSubmissionIntent(operator.principal, { operationId: op("wrong-unit"), unitId: B.unitId, authorizationId: disposition.disposition.id, evidence: "Synthetic original authorization must not apply to B" }));
      const prepared = await Promise.all([1,2].map(() => submissions.prepareMarsSubmissionIntent(operator.principal, { operationId: op("prepare"), unitId: A.unitId, authorizationId: disposition.disposition.id, evidence: "Synthetic exact original scan and RTV authority" })));
      assert.equal(prepared[0].intent.id, prepared[1].intent.id); assert.equal(await prisma.marsSubmissionIntent.count({ where: { unitId: A.unitId } }), 1);
      const input = { operationId: op("start"), intentId: prepared[0].intent.id, expectedRevision: 1, evidence: "Synthetic human handoff, no upstream endpoint called" };
      const started = await submissions.startMarsSubmissionIntent(operator.principal, input); assert.equal(started.upstreamSubmitted, false); assert.equal((await submissions.startMarsSubmissionIntent(operator.principal, input)).replayed, true);
      const uncertain = await submissions.markMarsSubmissionUnknown(operator.principal, { operationId: op("uncertain"), intentId: started.intent.id, expectedRevision: started.intent.revision, evidence: "Synthetic external page response unavailable" });
      await assert.rejects(submissions.startMarsSubmissionIntent(operator.principal, { ...input, operationId: op("bad-retry"), expectedRevision: uncertain.intent.revision }), /Reconcile/);
      await assert.rejects(submissions.cancelMarsSubmissionIntent(operator.principal, { ...input, operationId: op("bad-cancel"), expectedRevision: uncertain.intent.revision }));
      const linked = await submissions.reconcileMarsSubmissionIntent(operator.principal, { operationId: op("link"), intentId: uncertain.intent.id, expectedRevision: uncertain.intent.revision, outcome: "linked", requestNumber: "7000001", evidence: "Synthetic operator verified existing submission detail for original A" }); assert.equal(linked.intent.state, "linked");
      assert.equal((await warehouse.resolveWarehouseIdentifier(operator.principal, { value: "7000001", kind: "submission", namespace: "mars" })).unitId, A.unitId);
      await assert.rejects(submissions.linkMarsSubmission(admin.principal, { operationId: op("cross-unit"), unitId: B.unitId, requestNumber: "7000001", evidence: "Synthetic wrong replacement mapping refusal" }), /another physical unit/);
      const handoff = await submissions.getMarsLabelHandoff(operator.principal, { unitId: A.unitId, requestNumber: "7000001" }); assert.ok(handoff.labelUrl.startsWith("/tools/rtv-label#mars-unit=")); assert.equal(handoff.printed, false);
      const current = await mars.getMarsAudit(operator.principal, { auditSessionId: auditId }); assert.deepEqual(current?.savedReports[0].payload, savedPayload);
      assert.ok((await mars.getMarsSourceRows(operator.principal, { requestNumber: "7000001", limit: 1 })).nextCursor, "Full source history is paged explicitly, never silently replaced or truncated.");
    });
  } finally { await prisma.$disconnect(); const { prisma: shared } = await import("../lib/db"); await shared.$disconnect(); }
});
