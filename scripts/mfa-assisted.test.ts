import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { generate } from "otplib";
import { hashPassword } from "../lib/auth/passwords";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal, type SessionClaim } from "../lib/auth/principal";
import { maintenanceClient, maintenanceTarget } from "./v2-preflight-support";

const testUrl = process.env.FACTOR_RESET_TEST_DATABASE_URL;
test("assisted staff factor recovery enforces current scope/proof, revokes authority and preserves the last administrator", { skip: !testUrl }, async () => {
  const target = maintenanceTarget("temcotools_v2_factor_reset_test", false, testUrl);
  const prisma = maintenanceClient(target);
  process.env.DATABASE_URL = target.url; process.env.SESSION_SECRET = "synthetic-assisted-factor-reset-secret-2026"; process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x67).toString("base64url");
  assert.equal(await prisma.user.count(), 0, "Use a fresh dedicated synthetic factor-reset database.");
  const identity = await import("../lib/auth/identity"), mfa = await import("../lib/auth/mfa"), grants = await import("../lib/application/grants");
  const namespace = `factor-reset-${randomUUID()}`, password = "Synthetic private recovery password phrase 55", context = { source: namespace };
  async function principalFor(claim: SessionClaim): Promise<Principal> {
    const principal = await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    const session = await prisma.userSession.findUniqueOrThrow({ where: { id: claim.sessionId! } }); assert.ok(principal);
    return { ...principal, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
  }
  async function person(suffix: string, role: "admin" | "user") {
    const user = await prisma.user.create({ data: { username: `${namespace}-${suffix}`, displayName: "Synthetic recovery person", role, pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: `legacy-${role}` } } } });
    const login = await identity.signInWithPassword({ username: user.username, password }, context);
    const principal = await principalFor(login.claim), setup = await mfa.beginMfaEnrollment(principal, { password }, context);
    await mfa.confirmMfaEnrollment(principal, { token: await generate({ secret: setup.secret }) }, context);
    return { user, claim: login.claim, principal: await principalFor(login.claim) };
  }
  try {
    const admin = await person("admin", "admin"), staff = await person("staff", "user");
    await assert.rejects(mfa.issueAssistedFactorReset(admin.principal, { userId: admin.user.id, reason: "Synthetic last-admin refusal" }), /another enrolled active system administrator/);
    await assert.rejects(mfa.issueAssistedFactorReset(staff.principal, { userId: admin.user.id, reason: "Synthetic unauthorized refusal" }));
    const narrowGrant = await grants.createAccessGrant(admin.principal, { clientName: "Synthetic narrow recovery client", scopes: ["users.manage"], lifetimeMinutes: 5 });
    await assert.rejects(mfa.issueAssistedFactorReset(await grants.authenticateAccessGrant(narrowGrant.token), { userId: staff.user.id, reason: "Synthetic narrow scope refusal" }), /beyond its own scope/);
    await prisma.userSession.update({ where: { id: admin.claim.sessionId! }, data: { mfaVerifiedAt: new Date(Date.now() - 11 * 60_000) } });
    await assert.rejects(mfa.issueAssistedFactorReset(admin.principal, { userId: staff.user.id, reason: "Synthetic stale proof refusal" }), /Confirm an authenticator/);
    await prisma.userSession.update({ where: { id: admin.claim.sessionId! }, data: { mfaVerifiedAt: new Date() } }); admin.principal = await principalFor(admin.claim);
    const staffGrant = await grants.createAccessGrant(staff.principal, { clientName: "Synthetic target grant", scopes: ["inventory.read"], lifetimeMinutes: 5 });
    const oldRecovery = await identity.issueRecovery(admin.principal, { userId: staff.user.id, purpose: "reset", reason: "Synthetic old recovery credential" });
    const oldSecret = (await prisma.userMfa.findUniqueOrThrow({ where: { userId: staff.user.id } })).encryptedSecret;
    const reset = await mfa.issueAssistedFactorReset(admin.principal, { userId: staff.user.id, reason: "Verified synthetic staff identity after lost factors" });
    assert.match(reset.token, /^reset_[A-Za-z0-9_-]{43}$/); assert.ok(reset.expiresAt.getTime() - Date.now() <= 30 * 60_000);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: staff.user.id } })).passwordHash, null);
    assert.equal((await prisma.userMfa.findUniqueOrThrow({ where: { userId: staff.user.id } })).encryptedSecret, oldSecret);
    assert.equal((await prisma.userMfa.findUniqueOrThrow({ where: { userId: staff.user.id } })).enabledAt, null);
    assert.equal(await prisma.mfaRecoveryCode.count({ where: { userId: staff.user.id, consumedAt: null } }), 0);
    assert.ok((await prisma.userSession.findUniqueOrThrow({ where: { id: staff.claim.sessionId! } })).revokedAt);
    await assert.rejects(grants.authenticateAccessGrant(staffGrant.token));
    await assert.rejects(identity.signInWithPassword({ username: staff.user.username, password }, context));
    await assert.rejects(identity.redeemRecovery({ token: oldRecovery.token, password }, context), /invalid or expired/);
    await identity.redeemRecovery({ token: reset.token, password }, context);
    await assert.rejects(identity.redeemRecovery({ token: reset.token, password }, context), /invalid or expired/);
    const login = await identity.signInWithPassword({ username: staff.user.username, password }, context), current = await principalFor(login.claim);
    const setup = await mfa.beginMfaEnrollment(current, { password }, context);
    await mfa.confirmMfaEnrollment(current, { token: await generate({ secret: setup.secret }) }, context);
    const audit = await prisma.identityAudit.findMany({ where: { action: "assisted_factor_reset_issued" } }); assert.equal(audit.length, 1); assert.equal(audit[0].actorUserId, admin.user.id); assert.equal(audit[0].targetUserId, staff.user.id);
    assert.equal(JSON.stringify(audit).includes(reset.token), false); assert.equal(JSON.stringify(audit).includes(oldSecret), false);
  } finally { await prisma.$disconnect(); const { prisma: shared } = await import("../lib/db"); await shared.$disconnect(); }
});
