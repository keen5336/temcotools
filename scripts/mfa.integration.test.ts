import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { generate } from "otplib";
import { hashPassword } from "../lib/auth/passwords";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal, type SessionClaim } from "../lib/auth/principal";

const testUrl = process.env.IDENTITY_TEST_DATABASE_URL;
test("privileged MFA commands against disposable PostgreSQL", { skip: !testUrl }, async (suite) => {
  const url = new URL(testUrl!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname), "Refusing nonlocal MFA test database");
  assert.equal(url.pathname, "/temcotools_v2_test", "Refusing non-test MFA database");
  process.env.DATABASE_URL = testUrl;
  process.env.SESSION_SECRET = "synthetic-mfa-test-session-secret-2026";
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x4d).toString("base64url");
  const { prisma } = await import("../lib/db");
  const identity = await import("../lib/auth/identity");
  const mfa = await import("../lib/auth/mfa");
  const namespace = `mfa-test-${randomUUID()}`;
  const context = { source: namespace };
  const password = "Synthetic authenticator password phrase 9";
  const user = await prisma.user.create({ data: {
    username: `${namespace}-admin`, displayName: "Synthetic MFA administrator", role: "admin", pinHash: "disabled:v2",
    passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: "legacy-admin" } },
  } });
  async function principalFor(claim: SessionClaim): Promise<Principal> {
    const current = await resolvePrincipal(claim, (id) => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    const session = await prisma.userSession.findUnique({ where: { id: claim.sessionId } });
    assert.ok(current && session);
    return { ...current, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() };
  }
  const login = await identity.signInWithPassword({ username: user.username, password }, context);
  let actor = await principalFor(login.claim);
  let secret = "";
  let recoveryCodes: string[] = [];
  try {
    await suite.test("new administrator enrolls a real synthetic authenticator without an existing second factor", async () => {
      await assert.rejects(prisma.$transaction((tx) => identity.assertCurrentPrincipal(tx, actor, "users.manage", true)));
      const setup = await mfa.beginMfaEnrollment(actor, { password }, context);
      secret = setup.secret;
      assert.ok(setup.uri.startsWith("otpauth://totp/"));
      const stored = await prisma.userMfa.findUnique({ where: { userId: user.id } });
      assert.ok(stored && stored.encryptedSecret !== secret && !stored.enabledAt);
      const enrolled = await mfa.confirmMfaEnrollment(actor, { token: await generate({ secret }) }, context);
      recoveryCodes = enrolled.recoveryCodes;
      assert.equal(recoveryCodes.length, 10);
      actor = await principalFor(login.claim);
      await prisma.$transaction((tx) => identity.assertCurrentPrincipal(tx, actor, "users.manage", true));
      const hashes = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
      assert.equal(hashes.some((row) => recoveryCodes.includes(row.codeHash)), false);
    });
    await suite.test("authenticator replay and wrong-password verification fail without refreshing privileged proof", async () => {
      const before = (await prisma.userSession.findUnique({ where: { id: actor.sessionId } }))!.mfaVerifiedAt;
      await assert.rejects(mfa.verifyMfa(actor, { password, token: await generate({ secret }) }, context));
      await assert.rejects(mfa.verifyMfa(actor, { password: "Wrong synthetic password", recoveryCode: recoveryCodes[0] }, context));
      const after = (await prisma.userSession.findUnique({ where: { id: actor.sessionId } }))!.mfaVerifiedAt;
      assert.equal(after?.getTime(), before?.getTime());
    });
    await suite.test("one recovery code cannot be accepted by two concurrent verification requests", async () => {
      const outcomes = await Promise.allSettled([
        mfa.verifyMfa(actor, { password, recoveryCode: recoveryCodes[0] }, context),
        mfa.verifyMfa(actor, { password, recoveryCode: recoveryCodes[0] }, context),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal((await mfa.getMfaStatus(actor)).remainingRecoveryCodes, 9);
    });
    await suite.test("recovery-code replacement invalidates all earlier codes and returns a new private batch", async () => {
      const replacement = await mfa.regenerateMfaRecoveryCodes(actor, { password, recoveryCode: recoveryCodes[1] }, context);
      assert.equal(replacement.recoveryCodes.length, 10);
      await assert.rejects(mfa.verifyMfa(actor, { password, recoveryCode: recoveryCodes[2] }, context));
      recoveryCodes = replacement.recoveryCodes;
      await mfa.verifyMfa(actor, { password, recoveryCode: recoveryCodes[0] }, context);
    });
    await suite.test("disable requires password plus a fresh second factor and removes privileged proof across sessions", async () => {
      await assert.rejects(mfa.disableMfa(actor, { password, recoveryCode: recoveryCodes[1] }, context), /another enrolled active system administrator/);
      const backup = await prisma.user.create({ data: { username: `${namespace}-backup`, displayName: "Synthetic backup administrator", pinHash: "disabled:v2", role: "admin", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: "legacy-admin" } } } });
      const backupLogin = await identity.signInWithPassword({ username: backup.username, password }, { source: `${namespace}-backup` });
      const backupActor = await principalFor(backupLogin.claim);
      const setup = await mfa.beginMfaEnrollment(backupActor, { password }, { source: `${namespace}-backup` });
      await mfa.confirmMfaEnrollment(backupActor, { token: await generate({ secret: setup.secret }) }, { source: `${namespace}-backup` });
      const other = await identity.signInWithPassword({ username: user.username, password }, context);
      await mfa.disableMfa(actor, { password, recoveryCode: recoveryCodes[1] }, context);
      assert.equal((await mfa.getMfaStatus(actor)).enabled, false);
      await assert.rejects(prisma.$transaction((tx) => identity.assertCurrentPrincipal(tx, actor, "users.manage", true)));
      assert.ok((await prisma.userSession.findUnique({ where: { id: other.claim.sessionId } }))?.revokedAt);
      assert.equal(await prisma.mfaRecoveryCode.count({ where: { userId: user.id } }), 0);
      const audit = await prisma.identityAudit.findMany({ where: { targetUserId: user.id } });
      assert.ok(audit.some((row) => row.action === "mfa_disabled"));
      assert.equal(JSON.stringify(audit).includes(secret), false);
      assert.equal(recoveryCodes.some((code) => JSON.stringify(audit).includes(code)), false);
    });
    await suite.test("pending enrollment is bound to its session and expires without enabling a factor", async () => {
      const otherUser = await prisma.user.create({ data: { username: `${namespace}-pending`, displayName: "Synthetic pending operator", pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: "legacy-user" } } } });
      const first = await identity.signInWithPassword({ username: otherUser.username, password }, { source: `${namespace}-pending` });
      const second = await identity.signInWithPassword({ username: otherUser.username, password }, { source: `${namespace}-pending` });
      const a = await principalFor(first.claim), b = await principalFor(second.claim);
      const setup = await mfa.beginMfaEnrollment(a, { password }, { source: `${namespace}-pending` });
      await assert.rejects(mfa.confirmMfaEnrollment(b, { token: await generate({ secret: setup.secret }) }, { source: `${namespace}-pending` }));
      await prisma.userMfa.update({ where: { userId: otherUser.id }, data: { pendingExpiresAt: new Date(Date.now() - 1000) } });
      await assert.rejects(mfa.confirmMfaEnrollment(a, { token: await generate({ secret: setup.secret }) }, { source: `${namespace}-pending` }));
      assert.equal((await mfa.getMfaStatus(a)).enabled, false);
    });
  } finally {
    const ids = (await prisma.user.findMany({ where: { username: { startsWith: namespace } }, select: { id: true } })).map((row) => row.id);
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.identityAudit.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { targetUserId: { in: ids } }] } });
    await prisma.$disconnect();
  }
});
