import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { generate } from "otplib";
import { maintenanceClient, maintenanceTarget } from "./v2-preflight-support";
import { inspectV2Readiness } from "./v2-preflight";
import { backfillV2Inventory, invalidateRestoredAccess } from "./v2-backfill";
import { bootstrapV2Administrator } from "./v2-bootstrap";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal, type SessionClaim } from "../lib/auth/principal";

test("maintenance target guard requires exact explicit selection and fails before connection", () => {
  const synthetic = "postgresql://postgres@127.0.0.1:55439/temcotools_v2_recovery_test";
  assert.throws(() => maintenanceTarget(undefined, false, synthetic), /expect-database/);
  assert.throws(() => maintenanceTarget("other_test", false, synthetic), /does not match/);
  assert.throws(() => maintenanceTarget("production", false, "postgresql://localhost/production"), /loopback/);
  assert.throws(() => maintenanceTarget("temcotools_test", false, "postgresql://example.invalid/temcotools_test"), /loopback/);
  assert.throws(() => maintenanceTarget("temcotools_test", false, "https://localhost/temcotools_test"), /PostgreSQL/);
  assert.equal(maintenanceTarget("temcotools_v2_recovery_test", false, synthetic).operational, false);
  assert.equal(maintenanceTarget("production", true, "postgresql://localhost/production").operational, true);
});

const testUrl = process.env.MAINTENANCE_TEST_DATABASE_URL;
test("cutover enrollment, conservative backfill and recovery on the dedicated synthetic restore", { skip: !testUrl }, async (suite) => {
  const target = maintenanceTarget("temcotools_v2_recovery_test", false, testUrl);
  process.env.DATABASE_URL = target.url;
  process.env.SESSION_SECRET = "synthetic-maintenance-session-secret-2026";
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x56).toString("base64url");
  const prisma = maintenanceClient(target);
  assert.equal(await prisma.user.count(), 0, "Use a fresh task-owned restored database, never another user's test or operational data.");
  assert.equal(await prisma.inventoryAuditItem.count(), 0);
  const identity = await import("../lib/auth/identity");
  const mfa = await import("../lib/auth/mfa");
  const prefix = `V2-MAINT-${randomUUID().toUpperCase()}`;
  const privateDir = await mkdtemp(join(tmpdir(), "temco-maintenance-"));
  const username = `${prefix}-ADMIN`;
  const reason = `${prefix} owner-authorized synthetic cutover rehearsal`;
  const bootstrap = { username, displayName: "Synthetic cutover administrator", create: true, enrollExisting: false, apply: false };
  const password = "Synthetic owner chosen warehouse phrase 49";
  let claim: SessionClaim;
  const inventoryIds: string[] = [], unitIds: string[] = [];
  let adminId = "";
  async function principalFor(currentClaim: SessionClaim): Promise<Principal> {
    const principal = await resolvePrincipal(currentClaim, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    const session = await prisma.userSession.findUniqueOrThrow({ where: { id: currentClaim.sessionId! } });
    assert.ok(principal);
    return { ...principal, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
  }
  async function seedRow(suffix: string, unitId?: string) {
    const row = await prisma.inventoryAuditItem.create({ data: { id: `${prefix}-${suffix}`, lpn: `${prefix}-${suffix}`, unitId, status: "Stored", orderNumber: "SYNTHETIC-ORDER", vendor: "Synthetic vendor", receivedDate: "2026-10-01", description: "Synthetic appliance", customerName: "Synthetic recipient", sourceData: { synthetic: suffix }, contentHash: `synthetic-${suffix}` } });
    inventoryIds.push(row.id); return row;
  }
  try {
    await suite.test("bootstrap is dry-run by default, requires private delivery and creates a hashed one-use code", async () => {
      assert.equal((await bootstrapV2Administrator(prisma, bootstrap)).mode, "dry-run");
      assert.equal(await prisma.user.count(), 0);
      await assert.rejects(bootstrapV2Administrator(prisma, { ...bootstrap, apply: true }), /reason/);
      await assert.rejects(bootstrapV2Administrator(prisma, { ...bootstrap, apply: true, reason, deliveryFile: join(process.cwd(), "not-a-secret") }), /outside/);
      const usedFile = join(privateDir, "existing"); await writeFile(usedFile, "synthetic sentinel", { mode: 0o600 });
      await assert.rejects(bootstrapV2Administrator(prisma, { ...bootstrap, apply: true, reason, deliveryFile: usedFile }), /never overwritten/);
      assert.equal(await readFile(usedFile, "utf8"), "synthetic sentinel");
      const deliveryFile = join(privateDir, "initial-enrollment");
      const result = await bootstrapV2Administrator(prisma, { ...bootstrap, apply: true, reason, deliveryFile });
      assert.equal(result.mode, "applied"); assert.equal((await stat(deliveryFile)).mode & 0o777, 0o600);
      const token = (await readFile(deliveryFile, "utf8")).trim(); assert.match(token, /^enroll_[A-Za-z0-9_-]{43}$/);
      const user = await prisma.user.findUniqueOrThrow({ where: { username } }); adminId = user.id;
      assert.equal(user.passwordHash, null); assert.equal(user.pinHash, "disabled:v2");
      const saved = await prisma.identityRecoveryToken.findFirstOrThrow({ where: { userId: user.id } });
      assert.equal(saved.tokenHash, createHash("sha256").update(token).digest("hex")); assert.ok(saved.expiresAt.getTime() - Date.now() <= 30 * 60_000);
      await identity.redeemRecovery({ token, password }, { source: prefix });
      await assert.rejects(identity.redeemRecovery({ token, password }, { source: prefix }), /invalid or expired/);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).id, user.id);
      claim = (await identity.signInWithPassword({ username, password, deviceLabel: "Synthetic phone" }, { source: prefix })).claim;
      const setup = await mfa.beginMfaEnrollment(await principalFor(claim), { password }, { source: prefix });
      await mfa.confirmMfaEnrollment(await principalFor(claim), { token: await generate({ secret: setup.secret }) }, { source: prefix });
      const readiness = await inspectV2Readiness(prisma);
      assert.equal(readiness.identity?.readyRecoveryAdministrators, 1);
      await assert.rejects(bootstrapV2Administrator(prisma, bootstrap), /already exists/);
    });

    await suite.test("backfill resumes safely, preserves corrections/scans and refuses immutable conflicts", async () => {
      const missing = await seedRow("MISSING"); unitIds.push(`wms-unit:${missing.id}`);
      const existingUnit = await prisma.warehouseUnit.create({ data: {} }); unitIds.push(existingUnit.id);
      const linked = await seedRow("LINKED", existingUnit.id);
      const revoked = await seedRow("REVOKED", existingUnit.id);
      const disputed = await seedRow("DISPUTED", existingUnit.id);
      const otherUnit = await prisma.warehouseUnit.create({ data: {} }); unitIds.push(otherUnit.id);
      const revokedAlias = await prisma.warehouseIdentifier.create({ data: { unitId: existingUnit.id, kind: "lpn", namespace: "wms", value: revoked.lpn, rawValue: revoked.lpn, evidence: "Synthetic correction", revokedAt: new Date(), revocationReason: "Synthetic owner correction" } });
      await prisma.warehouseIdentifier.create({ data: { unitId: otherUnit.id, kind: "lpn", namespace: "wms", value: disputed.lpn, rawValue: disputed.lpn, evidence: "Synthetic conflict" } });
      await prisma.inventoryAuditScan.create({ data: { sourceScanId: prefix, pickWaveId: prefix, pickWaveName: "Synthetic retained wave", scannedValue: missing.lpn, lpn: missing.lpn, matchedPickWave: false, duplicateInWave: false, scannedAt: new Date("2026-10-30T10:00:00Z") } });
      const beforeScans = await prisma.inventoryAuditScan.count(), beforeObservations = await prisma.warehousePhysicalObservation.count(), beforeMemberships = await prisma.inventoryImportMembership.count();
      const dry = await backfillV2Inventory(prisma, { apply: false }); assert.equal(dry.before.missingUnits, 1);
      assert.equal((await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { id: missing.id } })).unitId, null);
      let cursor: string | undefined;
      do { const page = await backfillV2Inventory(prisma, { apply: true, reason, limit: 2, after: cursor }); cursor = page.nextCursor ?? undefined; } while (cursor);
      const repeated = await backfillV2Inventory(prisma, { apply: true, reason });
      assert.equal(repeated.after.missingUnits, 0); assert.equal(repeated.after.missingCurrentRevisions, 0); assert.equal(repeated.after.conflictingAliases, 1);
      assert.equal((await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { id: linked.id } })).unitId, existingUnit.id);
      assert.equal(await prisma.warehouseIdentifier.count({ where: { unitId: existingUnit.id, value: revoked.lpn, revokedAt: null } }), 0);
      assert.ok((await prisma.warehouseIdentifier.findUniqueOrThrow({ where: { id: revokedAlias.id } })).revokedAt);
      assert.equal(await prisma.warehouseIdentifier.count({ where: { unitId: existingUnit.id, value: disputed.lpn } }), 0);
      assert.equal(await prisma.inventoryAuditScan.count(), beforeScans); assert.equal(await prisma.warehousePhysicalObservation.count(), beforeObservations); assert.equal(await prisma.inventoryImportMembership.count(), beforeMemberships);
      assert.equal(await prisma.inventorySourceRevision.count({ where: { inventoryItemId: { in: inventoryIds }, migrationSnapshot: true } }), 4);
      await prisma.inventorySourceRevision.update({ where: { inventoryItemId_revision: { inventoryItemId: missing.id, revision: 1 } }, data: { contentHash: "synthetic-conflict" } });
      await assert.rejects(backfillV2Inventory(prisma, { apply: true, reason }), /immutable/);
      assert.equal((await inspectV2Readiness(prisma)).inventory?.conflictingCurrentRevisions, 1);
      await prisma.inventorySourceRevision.update({ where: { inventoryItemId_revision: { inventoryItemId: missing.id, revision: 1 } }, data: { contentHash: missing.contentHash } });
    });

    await suite.test("explicit lost-factor admin recovery revokes access without promoting anyone or losing unit history", async () => {
      const old = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
      const oldMfa = await prisma.userMfa.findUniqueOrThrow({ where: { userId: adminId } });
      const base = { username, create: false, enrollExisting: false, recoverEnrolledAdmin: true, apply: false };
      assert.equal((await bootstrapV2Administrator(prisma, base)).mode, "dry-run");
      assert.ok((await prisma.userMfa.findUniqueOrThrow({ where: { userId: adminId } })).enabledAt);
      const grant = await prisma.appAccessGrant.create({ data: { tokenHash: `${prefix}-hash`, userId: adminId, sessionId: claim.sessionId, authVersion: old.authVersion, clientName: "Synthetic recovery client", scopes: ["inventory.read"], expiresAt: new Date(Date.now() + 60_000) } });
      const deliveryFile = join(privateDir, "emergency-recovery");
      await bootstrapV2Administrator(prisma, { ...base, apply: true, reason, deliveryFile });
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).passwordHash, null);
      assert.ok((await prisma.userSession.findUniqueOrThrow({ where: { id: claim.sessionId! } })).revokedAt);
      assert.ok((await prisma.appAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt);
      const disabled = await prisma.userMfa.findUniqueOrThrow({ where: { userId: adminId } }); assert.equal(disabled.enabledAt, null); assert.equal(disabled.encryptedSecret, oldMfa.encryptedSecret);
      assert.equal(await prisma.mfaRecoveryCode.count({ where: { userId: adminId, consumedAt: null } }), 0);
      const firstToken = (await readFile(deliveryFile, "utf8")).trim(); assert.match(firstToken, /^reset_/);
      // A lost/expired delivery file must not strand the now-disabled password.
      // An explicit reissue preserves the same admin/bundles and kills the old code.
      const replacementFile = join(privateDir, "emergency-recovery-reissued");
      await bootstrapV2Administrator(prisma, { ...base, apply: true, reason, deliveryFile: replacementFile });
      await assert.rejects(identity.redeemRecovery({ token: firstToken, password }, { source: `${prefix}-restored` }), /invalid or expired/);
      const token = (await readFile(replacementFile, "utf8")).trim();
      await identity.redeemRecovery({ token, password }, { source: `${prefix}-restored` });
      claim = (await identity.signInWithPassword({ username, password, deviceLabel: "Synthetic recovered phone" }, { source: prefix })).claim;
      const setup = await mfa.beginMfaEnrollment(await principalFor(claim), { password }, { source: prefix });
      await mfa.confirmMfaEnrollment(await principalFor(claim), { token: await generate({ secret: setup.secret }) }, { source: prefix });
      assert.equal(await prisma.inventorySourceRevision.count({ where: { inventoryItemId: { in: inventoryIds } } }), 4);
      assert.equal(await prisma.identityAudit.count({ where: { targetUserId: adminId, action: "offline_administrator_recovery_issued" } }), 2);
    });

    await suite.test("restore invalidation defaults read-only, retains authenticators/evidence and consumes restored recovery authority", async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
      const mfaSecret = (await prisma.userMfa.findUniqueOrThrow({ where: { userId: adminId } })).encryptedSecret;
      const dry = await invalidateRestoredAccess(prisma, { apply: false }); assert.ok(dry.affected.sessions > 0);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).authVersion, before.authVersion);
      await invalidateRestoredAccess(prisma, { apply: true, reason });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: adminId } }); assert.equal(after.authVersion, before.authVersion + 1); assert.equal(after.passwordHash, before.passwordHash);
      assert.equal((await prisma.userMfa.findUniqueOrThrow({ where: { userId: adminId } })).encryptedSecret, mfaSecret);
      assert.equal(await prisma.userSession.count({ where: { revokedAt: null } }), 0); assert.equal(await prisma.mfaRecoveryCode.count({ where: { consumedAt: null } }), 0);
      assert.equal(await prisma.inventorySourceRevision.count({ where: { inventoryItemId: { in: inventoryIds } } }), 4);
    });
  } finally {
    // Keep the dedicated synthetic recovery database and private delivery files
    // as restore-rehearsal evidence. Never clean another database or directory.
    await prisma.$disconnect();
    const { prisma: shared } = await import("../lib/db"); await shared.$disconnect();
  }
});
