import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { generate } from "otplib";
import { hashPassword } from "../lib/auth/passwords";
import { CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal, type Principal, type SessionClaim } from "../lib/auth/principal";

const testUrl = process.env.IDENTITY_TEST_DATABASE_URL;
test("identity commands against disposable PostgreSQL", { skip: !testUrl }, async (suite) => {
  const url = new URL(testUrl!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname), "Refusing nonlocal identity test database");
  assert.equal(url.pathname, "/temcotools_v2_test", "Refusing non-test identity database");
  process.env.DATABASE_URL = testUrl;
  process.env.SESSION_SECRET = "synthetic-identity-test-session-secret-2026";
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x49).toString("base64url");
  const { prisma } = await import("../lib/db");
  const identity = await import("../lib/auth/identity");
  const mfa = await import("../lib/auth/mfa");
  const namespace = `identity-test-${randomUUID()}`;
  const context = { source: namespace };
  const password = "Synthetic warehouse credential phrase 7";
  const admin = await prisma.user.create({ data: {
    username: `${namespace}-admin`, displayName: "Synthetic administrator", pinHash: "disabled:v2", role: "admin",
    passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: "legacy-admin" } },
  } });
  let passed = false;
  async function principalFor(claim: SessionClaim): Promise<Principal> {
    const principal = await resolvePrincipal(claim, (id) => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    const session = await prisma.userSession.findUnique({ where: { id: claim.sessionId! } });
    assert.ok(principal && session && isLivePersistentSession(session, claim));
    return { ...principal, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
  }
  try {
    const signedIn = await identity.signInWithPassword({ username: admin.username, password, deviceLabel: "Synthetic scanner" }, context);
    let actor = await principalFor(signedIn.claim);
    const setup = await mfa.beginMfaEnrollment(actor, { password }, context);
    await mfa.confirmMfaEnrollment(actor, { token: await generate({ secret: setup.secret }) }, context);
    actor = await principalFor(signedIn.claim);
    await suite.test("delegated access administration cannot assign or recover authority beyond its client scope", async () => {
      const { createAccessGrant, authenticateAccessGrant } = await import("../lib/application/grants");
      const grant = await createAccessGrant(actor, { clientName: "Synthetic narrow administrator", scopes: ["users.manage"], lifetimeMinutes: 5 });
      const narrow = await authenticateAccessGrant(grant.token);
      await assert.rejects(identity.createIdentityUser(narrow, { username: `${namespace}-forbidden`, displayName: "Synthetic forbidden account", role: "admin" }));
      await assert.rejects(identity.saveRoleBundle(narrow, { name: `${namespace}-forbidden`, capabilities: ["inventory.identify"] }));
      await assert.rejects(identity.issueRecovery(narrow, { userId: admin.id, purpose: "reset", reason: "Synthetic narrowed recovery refusal" }));
      await assert.rejects(identity.updateIdentityUser(narrow, { id: admin.id, bundleIds: ["legacy-admin"] }));
      assert.equal(await prisma.user.count({ where: { username: `${namespace}-forbidden` } }), 0);
      const permitted = await identity.saveRoleBundle(narrow, { name: `${namespace}-narrow`, capabilities: ["users.manage"] });
      assert.deepEqual(permitted.capabilities, ["users.manage"]);
    });
    let targetId = "";
    let targetName = "";
    let targetClaim: SessionClaim;
    await suite.test("legacy PIN cannot authenticate; admin creates an unenrolled account without choosing its password", async () => {
      const target = await identity.createIdentityUser(actor, { username: `${namespace}-operator`, displayName: "Synthetic operator" });
      targetId = target.id; targetName = target.username;
      await assert.rejects(identity.signInWithPassword({ username: targetName, password: "1234" }, context), (error: unknown) => error instanceof identity.IdentityError && error.status === 401);
      await assert.rejects(identity.signInWithPassword({ username: targetName, pin: "1234" }, context));
      assert.equal((await prisma.user.findUnique({ where: { id: targetId } }))?.passwordHash, null);
    });
    await suite.test("assisted enrollment code is hashed, one use and audited; enrolled password signs in", async () => {
      const issued = await identity.issueRecovery(actor, { userId: targetId, purpose: "enroll", reason: "Synthetic identity verified in controlled test" });
      const stored = await prisma.identityRecoveryToken.findUnique({ where: { id: issued.id } });
      assert.ok(stored && stored.tokenHash !== issued.token && !stored.consumedAt);
      await identity.redeemRecovery({ token: issued.token, password }, context);
      await assert.rejects(identity.redeemRecovery({ token: issued.token, password }, context), (error: unknown) => error instanceof identity.IdentityError && error.status === 400);
      const login = await identity.signInWithPassword({ username: targetName, password }, context);
      targetClaim = login.claim;
      assert.ok(await principalFor(targetClaim));
      const events = await prisma.identityAudit.findMany({ where: { targetUserId: targetId } });
      assert.ok(events.some((event) => event.action === "password_recovered"));
      assert.equal(JSON.stringify(events).includes(issued.token), false);
    });
    await suite.test("expired and racing reset codes do not produce repeated credential changes", async () => {
      const expired = await identity.issueRecovery(actor, { userId: targetId, purpose: "reset", reason: "Synthetic expired code scenario" });
      await prisma.identityRecoveryToken.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await assert.rejects(identity.redeemRecovery({ token: expired.token, password }, context));
      const issued = await identity.issueRecovery(actor, { userId: targetId, purpose: "reset", reason: "Synthetic concurrent code scenario" });
      const outcomes = await Promise.allSettled([identity.redeemRecovery({ token: issued.token, password }, context), identity.redeemRecovery({ token: issued.token, password }, context)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.ok((await prisma.userSession.findUnique({ where: { id: targetClaim.sessionId! } }))?.revokedAt);
    });
    await suite.test("individual session revocation cannot target another user's session", async () => {
      const login = await identity.signInWithPassword({ username: targetName, password }, context);
      const target = await principalFor(login.claim);
      const denied = await identity.revokeSession(actor, { sessionId: target.sessionId });
      assert.equal(denied.revoked, false);
      const other = await identity.signInWithPassword({ username: targetName, password }, context);
      const others = await identity.revokeOtherSessions(target);
      assert.ok(others.revokedCount > 0);
      assert.ok((await prisma.userSession.findUnique({ where: { id: other.claim.sessionId } }))?.revokedAt);
      assert.equal((await prisma.userSession.findUnique({ where: { id: target.sessionId } }))?.revokedAt, null);
      const revoked = await identity.revokeSession(target, { sessionId: target.sessionId });
      assert.equal(revoked.current, true);
      await assert.rejects(prisma.$transaction((tx) => identity.assertCurrentPrincipal(tx, target)));
    });
    await suite.test("real idle expiry and lock prevent new commands, while recent password confirmation gates administration", async () => {
      const login = await identity.signInWithPassword({ username: targetName, password }, context);
      const target = await principalFor(login.claim);
      await prisma.userSession.update({ where: { id: target.sessionId }, data: { lastActivityAt: new Date(Date.now() - 31 * 60_000) } });
      await assert.rejects(identity.recordActivity(target));
      const active = await identity.signInWithPassword({ username: targetName, password }, context);
      const live = await principalFor(active.claim);
      await identity.lockSession(live);
      await assert.rejects(identity.listSessions(live));
      await prisma.userSession.update({ where: { id: actor.sessionId }, data: { lastStrongAuthenticatedAt: new Date(Date.now() - 11 * 60_000) } });
      await assert.rejects(identity.issueRecovery(actor, { userId: targetId, purpose: "reset", reason: "Synthetic stale confirmation scenario" }));
      await identity.reauthenticate(actor, { password }, context);
      assert.ok(await identity.issueRecovery(actor, { userId: targetId, purpose: "reset", reason: "Synthetic fresh confirmation scenario" }));
    });
    await suite.test("explicit multiple bundle assignment revokes old sessions and manager baseline has no new identity authority", async () => {
      const custom = await identity.saveRoleBundle(actor, { name: `${namespace}-review`, capabilities: ["inventory.identify"] });
      const login = await identity.signInWithPassword({ username: targetName, password }, context);
      await identity.updateIdentityUser(actor, { id: targetId, bundleIds: ["legacy-user", custom.id] });
      assert.ok((await prisma.userSession.findUnique({ where: { id: login.claim.sessionId } }))?.revokedAt);
      const current = await identity.signInWithPassword({ username: targetName, password }, context);
      assert.equal((await principalFor(current.claim)).capabilities.includes("inventory.identify"), true);
      const manager = await prisma.roleBundle.findUnique({ where: { id: "legacy-manager" } });
      assert.equal(manager?.capabilities.includes("inventory.identify"), false);
    });
    await suite.test("public recovery is neutral and account attempt budget persists despite changing source hints", async () => {
      const known = await identity.requestRecovery({ username: targetName }, context);
      const unknown = await identity.requestRecovery({ username: `${namespace}-absent` }, context);
      assert.equal(known.message, unknown.message);
      for (let i = 0; i < 12; i++) await identity.consumeIdentityBudget("login", `${namespace}-throttled`, { source: `${namespace}-${i}` });
      await assert.rejects(identity.consumeIdentityBudget("login", `${namespace}-throttled`, { source: `${namespace}-extra` }), (error: unknown) => error instanceof identity.IdentityError && error.status === 429);
    });
    await suite.test("password change and sign-out revoke persistent sessions", async () => {
      const login = await identity.signInWithPassword({ username: targetName, password }, context);
      const target = await principalFor(login.claim);
      await identity.changePassword(target, { currentPassword: password, newPassword: "Another synthetic long credential phrase 8" }, context);
      await assert.rejects(identity.listSessions(target));
      const next = await identity.signInWithPassword({ username: targetName, password: "Another synthetic long credential phrase 8" }, context);
      await identity.endSession(next.claim);
      assert.ok((await prisma.userSession.findUnique({ where: { id: next.claim.sessionId } }))?.revokedAt);
    });
    passed = true;
  } finally {
    if (passed) {
      const ids = (await prisma.user.findMany({ where: { username: { startsWith: namespace } }, select: { id: true } })).map((user) => user.id);
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.roleBundle.deleteMany({ where: { name: { startsWith: namespace } } });
      await prisma.identityAudit.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { targetUserId: { in: ids } }] } });
    }
    await prisma.$disconnect();
  }
});
