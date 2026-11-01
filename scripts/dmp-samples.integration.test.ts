import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";

test("private sample intake uses native current authority/custody without payload audit, automatic replay or file-scope bypass", { skip: !process.env.DATABASE_URL }, async t => {
  const target = new URL(process.env.DATABASE_URL!); assert.equal(target.protocol, "postgresql:"); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_samples_test"); assert.equal(target.search, "");
  const root = await fs.mkdtemp("/Volumes/MacDev/ProjectArchive/Development/Qualification/temcotools-dmp-samples-");
  process.env.ADMIN_FILE_MANAGER_ROOT = root;
  const { prisma } = await import("../lib/db"), { createDmpSampleCommands, dmpSamplesSaveInput } = await import("../lib/dmp-samples"), { adminEntryFingerprint } = await import("../lib/admin-files");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const samples = createDmpSampleCommands(root), now = Date.now(), prefix = `samples-${randomUUID()}`;
  const bundle = await prisma.roleBundle.create({ data: { name: prefix, capabilities: [...CAPABILITIES] } });
  const users: string[] = []; let passed = false;
  async function actor(name: string): Promise<Principal> {
    const user = await prisma.user.create({ data: { username: `${prefix}-${name}`, displayName: "Synthetic sample operator", pinHash: "disabled:synthetic", role: "admin", roleBundles: { create: { bundleId: bundle.id } } } }); users.push(user.id);
    const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, expiresAt: new Date(now + 3_600_000), deviceLabel: "Synthetic sample intake", mfaVerifiedAt: new Date() } });
    return { userId: user.id, username: user.username, displayName: user.displayName, role: user.role, authVersion: user.authVersion, sessionId: session.id, capabilities: [...CAPABILITIES], strongAuthenticatedAt: now, mfaVerifiedAt: now };
  }
  const a = await actor("A"), b = await actor("B"), readOnly = { ...a, capabilities: ["workflow.read"] as const };
  const xml = '<Output Type="listRouteDetail1"><parmDocRouteDetail><DocRouteDetail ID="SYNTHETIC-ROUTE"><FWOrderLine Order="SYNTHETIC-PRIVATE-ORDER" Sequence="1"/><FWOrderLine Order="SYNTHETIC-PRIVATE-ORDER" Sequence="2"/></DocRouteDetail></parmDocRouteDetail></Output>';
  const input = { operationId: randomUUID(), sourceKind: "route_planner_export", sourceMethod: "POST", sourceDay: "2026-10-31", format: "xml", body: xml, reviewedBodyOnly: true };
  try {
    let id = "", hash = "";
    await t.test("manual POST Route Planner retains exact body/date precision, structure-only default and same-ID receipt", async () => {
      const [saved, same] = await Promise.all([samples.saveDmpSample(readOnly, input), samples.saveDmpSample(readOnly, input)]);
      const receipt = saved.ok ? saved : same; assert.equal(receipt.ok, true); id = receipt.sample!.sampleId; hash = receipt.sample!.contentHash;
      assert.equal(hash, sha(xml)); assert.equal(receipt.sample!.sourceDay, "2026-10-31"); assert.equal(receipt.sample!.sourceAsOf, null); assert.equal(receipt.sample!.exportedAt, null); assert.equal(receipt.sample!.qualification, "manual_sample_only");
      assert.deepEqual(await samples.saveDmpSample(readOnly, input), receipt);
      assert.deepEqual(await samples.saveDmpSample(readOnly, { ...input, receiptOnly: true }), receipt);
      await assert.rejects(samples.saveDmpSample(readOnly, { ...input, body: '<Output/>' }), /different sample/);
      const result = await samples.inspectDmpSample(readOnly, { sampleId: id }); assert.equal(result.status, "inspected"); assert.equal(JSON.stringify(result).includes("SYNTHETIC-PRIVATE-ORDER"), false);
      const values = await samples.inspectDmpSample(readOnly, { sampleId: id, fieldPath: "/Output/parmDocRouteDetail/DocRouteDetail/FWOrderLine/@Order", limit: 1 }); assert.equal("values" in values && values.values?.items[0].value, "SYNTHETIC-PRIVATE-ORDER"); assert.equal("values" in values && values.values?.totalOccurrences, 2);
      const files = await fs.readdir(path.join(root, "dmp-samples", sha(a.userId))); assert.equal(files.length, 1); const file = path.join(root, "dmp-samples", sha(a.userId), files[0]); assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).body, xml);
    });
    await t.test("own scope/current revocation and metadata-only audits are enforced", async () => {
      assert.equal((await samples.listDmpSamples(b)).samples.length, 0); await assert.rejects(samples.inspectDmpSample(b, { sampleId: id }));
      await assert.rejects(samples.inspectDmpSample({ ...a, capabilities: ["inventory.read"] }, { sampleId: id }));
      const audit = await prisma.identityAudit.findMany({ where: { actorUserId: a.userId, action: { startsWith: "dmp_sample." } } });
      assert.equal(JSON.stringify(audit).includes("SYNTHETIC-PRIVATE-ORDER"), false); assert.equal(JSON.stringify(audit).includes("FWOrderLine"), false);
      await prisma.userSession.update({ where: { id: b.sessionId }, data: { revokedAt: new Date() } }); await assert.rejects(samples.listDmpSamples(b), /session ended/);
      assert.throws(() => dmpSamplesSaveInput.parse({ ...input, sourceAsOf: "2026-11-01T01:00:00" })); assert.throws(() => dmpSamplesSaveInput.parse({ ...input, sourceDay: "2026-02-30" })); assert.throws(() => dmpSamplesSaveInput.parse({ ...input, headers: {} }));
    });
    await t.test("canonical MCP discovery/actions share strict schemas and an actual minimal grant without general-file access", async () => {
      const { executeApplicationAction, listApplicationActions } = await import("../lib/application/actions");
      const { createAccessGrant, authenticateAccessGrant, revokeAccessGrant } = await import("../lib/application/grants");
      const issued = await createAccessGrant(a, { clientName: "Synthetic private source inspection", scopes: ["workflow.read"] });
      const client = await authenticateAccessGrant(issued.token), actions = listApplicationActions(client, { prefix: "dmp.samples.", includeSchemas: true });
      assert.deepEqual(actions.map(action => action.name).sort(), ["dmp.samples.inspect", "dmp.samples.list", "dmp.samples.remove", "dmp.samples.routeContext", "dmp.samples.save"]);
      assert.ok(actions.every(action => action.inputSchema));
      assert.deepEqual(await executeApplicationAction(client, "dmp.samples.inspect", { sampleId: id }), await samples.inspectDmpSample(readOnly, { sampleId: id }));
      const beforePhysical = await prisma.warehousePhysicalObservation.count();
      const routeList = await samples.getDmpSampleRouteContext(readOnly, { sampleId: id }); assert.equal(routeList.selectedRoute, null); assert.equal(routeList.routes[0].orderLineCount, 2);
      assert.deepEqual(await executeApplicationAction(client, "dmp.samples.routeContext", { sampleId: id, routePath: routeList.routes[0].routePath, limit: 10 }), await samples.getDmpSampleRouteContext(readOnly, { sampleId: id, routePath: routeList.routes[0].routePath, limit: 10 }));
      assert.equal(await prisma.warehousePhysicalObservation.count(), beforePhysical, "Source context cannot manufacture physical observation or completion.");
      await assert.rejects(samples.getDmpSampleRouteContext(b, { sampleId: id }));
      await assert.rejects(executeApplicationAction(client, "dmp.samples.save", { ...input, operationId: randomUUID(), headers: {} }));
      await assert.rejects(executeApplicationAction(client, "files.download", { path: "anything" }));
      await revokeAccessGrant(a, issued.grant.id);
      await assert.rejects(executeApplicationAction(client, "dmp.samples.inspect", { sampleId: id }), /expired or was revoked/);
      await prisma.roleBundle.update({ where: { id: bundle.id }, data: { capabilities: ["inventory.read"] } });
      try { await assert.rejects(samples.inspectDmpSample(readOnly, { sampleId: id })); } finally { await prisma.roleBundle.update({ where: { id: bundle.id }, data: { capabilities: [...CAPABILITIES] } }); }
    });
    await t.test("optional original READ proof binds exact body/hash/user/method and never executes a request", async () => {
      const operationId = randomUUID(), body = '{"orders":[{"id":"SYNTHETIC-READ"}]}';
      await prisma.dmpOperation.create({ data: { actorUserId: a.userId, actorSessionId: a.sessionId!, operationId, operation: "synthetic_read_only", method: "GET", connectionId: "synthetic-offline", inputHash: "synthetic", state: "response_observed", upstreamStatus: 200, responseHash: sha(JSON.stringify(body)), completedAt: new Date() } });
      const request = { ...input, operationId: randomUUID(), sourceKind: "dmp_export", sourceMethod: "GET", originalDmpOperationId: operationId, format: "json", body };
      const saved = await samples.saveDmpSample(readOnly, request); assert.equal(saved.ok, true); assert.equal(saved.sample?.provenance, "verified_original_read_body");
      assert.equal((await samples.saveDmpSample(readOnly, { ...request, operationId: randomUUID(), body: body + " " })).status, "not_applied");
      assert.throws(() => dmpSamplesSaveInput.parse({ ...request, sourceMethod: "POST" }));
      const wrongActor = await actor("wrong-read"); assert.equal((await samples.saveDmpSample(wrongActor, { ...request, operationId: randomUUID() })).status, "not_applied");
    });
    await t.test("managed references require files.manage/current fingerprint; XLSX remains opaque and source file survives removal", async () => {
      const filename = "synthetic.xlsx", bytes = Buffer.from("Synthetic opaque worksheet fixture, not a parsed XLSX archive."); await fs.writeFile(path.join(root, filename), bytes, { mode: 0o600 });
      const expectedFingerprint = adminEntryFingerprint(await fs.stat(path.join(root, filename)));
      const request = { ...input, operationId: randomUUID(), body: undefined, format: "opaque", managedFile: { path: filename, expectedFingerprint } };
      assert.equal((await samples.saveDmpSample(readOnly, request)).status, "not_applied");
      const saved = await samples.saveDmpSample(a, { ...request, operationId: randomUUID() }); assert.equal(saved.ok, true); const opaqueId = saved.sample!.sampleId;
      const opaque = await samples.inspectDmpSample(a, { sampleId: opaqueId }); assert.equal(opaque.status, "opaque_export"); assert.equal("structure" in opaque, false); await assert.rejects(samples.inspectDmpSample(readOnly, { sampleId: opaqueId }));
      await fs.appendFile(path.join(root, filename), "changed"); await assert.rejects(samples.inspectDmpSample(a, { sampleId: opaqueId }), /changed/);
      assert.equal((await samples.removeDmpSample(readOnly, { operationId: randomUUID(), sampleId: opaqueId, expectedContentHash: saved.sample!.contentHash })).ok, true); assert.ok(await fs.stat(path.join(root, filename)));
      const xmlFile = "synthetic-route-body.xml"; await fs.writeFile(path.join(root, xmlFile), xml, { mode: 0o600 });
      const managedXml = await samples.saveDmpSample(a, { ...input, operationId: randomUUID(), body: undefined, managedFile: { path: xmlFile, expectedFingerprint: adminEntryFingerprint(await fs.stat(path.join(root, xmlFile))) } }); assert.equal(managedXml.ok, true);
      assert.equal((await samples.getDmpSampleRouteContext(a, { sampleId: managedXml.sample!.sampleId })).routes[0].orderLineCount, 2);
      await assert.rejects(samples.getDmpSampleRouteContext(readOnly, { sampleId: managedXml.sample!.sampleId }));
      await fs.appendFile(path.join(root, xmlFile), " "); await assert.rejects(samples.getDmpSampleRouteContext(a, { sampleId: managedXml.sample!.sampleId }), /changed/);
    });
    await t.test("durable started/unknown save never replays and remains inspectable after lost ACK", async () => {
      const original = randomUUID(), body = '{"x":"SYNTHETIC-UNKNOWN"}', request = { ...input, operationId: original, format: "json", body };
      const { receiptOnly: _receiptOnly, ...intent } = dmpSamplesSaveInput.parse(request); void _receiptOnly;
      const inputFingerprint = sha(JSON.stringify({ ...intent, body: sha(body) })), sourceHash = sha(`dmp-sample:${path.resolve(root)}:${a.userId}:${original}`);
      await prisma.identityAudit.create({ data: { actorUserId: a.userId, sessionId: a.sessionId, action: "dmp_sample.operation_started", sourceHash, reason: JSON.stringify({ operationId: original, action: "save", inputFingerprint }) } });
      const receipt = await samples.saveDmpSample(readOnly, request); assert.equal(receipt.status, "unknown"); assert.equal(receipt.inspectionSampleId, sha(`sample:${a.userId}:${original}`));
      const listing = await samples.listDmpSamples(readOnly); assert.ok(listing.unsettled.some(item => item.operationId === original));
      await assert.rejects(fs.stat(path.join(root, "dmp-samples", sha(a.userId), `${receipt.inspectionSampleId}.json`)), { code: "ENOENT" });
      const neverSent = { ...request, operationId: randomUUID(), receiptOnly: true };
      const before = await prisma.identityAudit.count({ where: { actorUserId: a.userId } }); assert.equal((await samples.saveDmpSample(readOnly, neverSent)).status, "not_applied");
      assert.equal(await prisma.identityAudit.count({ where: { actorUserId: a.userId } }), before, "Receipt-only check cannot manufacture a new command or file effect.");
      await assert.rejects(fs.stat(path.join(root, "dmp-samples", sha(a.userId), `${sha(`sample:${a.userId}:${neverSent.operationId}`)}.json`)), { code: "ENOENT" });
    });
    await t.test("actual post-file-write receipt failure retains custody without replay and permits owner inspection", async () => {
      const suffix = randomUUID().replace(/-/g, ""), functionName = `samples_ack_${suffix}`, triggerName = `samples_ack_${suffix}`;
      const escapedUser = a.userId.replace(/'/g, "''");
      await prisma.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'dmp_sample.operation_completed' AND NEW."actorUserId" = TG_ARGV[0] THEN RAISE EXCEPTION 'synthetic sample acknowledgement failure'; END IF; RETURN NEW; END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON "IdentityAudit" FOR EACH ROW EXECUTE FUNCTION ${functionName}('${escapedUser}')`);
      const request = { ...input, operationId: randomUUID(), format: "json", body: '{"x":"SYNTHETIC-ACK-LOST"}' };
      try {
        const receipt = await samples.saveDmpSample(readOnly, request); assert.equal(receipt.status, "unknown"); const unknownId = receipt.inspectionSampleId!;
        const filename = path.join(root, "dmp-samples", sha(a.userId), `${unknownId}.json`), before = await fs.stat(filename);
        assert.equal((await samples.inspectDmpSample(readOnly, { sampleId: unknownId })).status, "inspected");
        assert.ok((await samples.listDmpSamples(readOnly)).unsettled.some(item => item.inspectionSampleId === unknownId));
        assert.deepEqual(await samples.saveDmpSample(readOnly, request), receipt); assert.equal((await fs.stat(filename)).mtimeMs, before.mtimeMs);
      } finally { await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON "IdentityAudit"`); await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`); }
    });
    await t.test("explicit own removal is idempotent and retains metadata without creating new evidence", async () => {
      const request = { operationId: randomUUID(), sampleId: id, expectedContentHash: hash };
      const removed = await samples.removeDmpSample(readOnly, request); assert.equal(removed.ok, true); assert.deepEqual(await samples.removeDmpSample(readOnly, request), removed); await assert.rejects(samples.inspectDmpSample(readOnly, { sampleId: id }));
      assert.equal((await samples.listDmpSamples(readOnly)).samples.find(sample => sample.sampleId === id)?.retained, false);
    });
    passed = true;
  } finally {
    await prisma.dmpOperation.deleteMany({ where: { actorUserId: { in: users } } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: { in: users } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.roleBundle.delete({ where: { id: bundle.id } }); await prisma.$disconnect();
    if (passed) await fs.rm(root, { recursive: true, force: false }); else console.log(`Synthetic failed sample evidence retained at ${root}`);
  }
});
