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
    await suite.test("concurrent case variants cannot create duplicate account identities", async () => {
      const username = `${namespace}-case-variant`;
      const outcomes = await Promise.allSettled([
        identity.createIdentityUser(actor, { username, displayName: "Synthetic concurrent account" }),
        identity.createIdentityUser(actor, { username: username.toUpperCase(), displayName: "Synthetic concurrent account" }),
      ]);
      assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
      assert.equal(await prisma.user.count({ where: { username: { equals: username, mode: "insensitive" } } }), 1);
      const refused = outcomes.find(outcome => outcome.status === "rejected");
      assert.ok(refused?.status === "rejected" && refused.reason instanceof identity.IdentityError && refused.reason.status === 409);
    });
    await suite.test("delegated access administration cannot assign or recover authority beyond its client scope", async () => {
      const { createAccessGrant, authenticateAccessGrant } = await import("../lib/application/grants");
      const grant = await createAccessGrant(actor, { clientName: "Synthetic narrow administrator", scopes: ["users.manage"], lifetimeMinutes: 5 });
      const narrow = await authenticateAccessGrant(grant.token);
      await assert.rejects(identity.createIdentityUser(narrow, { username: `${namespace}-forbidden`, displayName: "Synthetic forbidden account", role: "admin" }));
      await assert.rejects(identity.saveRoleBundle(narrow, { name: `${namespace}-forbidden`, capabilities: ["inventory.identify"] }));
      await assert.rejects(identity.issueRecovery(narrow, { userId: admin.id, purpose: "reset", reason: "Synthetic narrowed recovery refusal" }));
      await assert.rejects(identity.updateIdentityUser(narrow, { id: admin.id, expectedAuthVersion: admin.authVersion, bundleIds: ["legacy-admin"] }));
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
      await identity.updateIdentityUser(actor, { id: targetId, expectedAuthVersion: (await prisma.user.findUniqueOrThrow({ where: { id: targetId } })).authVersion, bundleIds: ["legacy-user", custom.id] });
      assert.ok((await prisma.userSession.findUnique({ where: { id: login.claim.sessionId } }))?.revokedAt);
      const current = await identity.signInWithPassword({ username: targetName, password }, context);
      assert.equal((await principalFor(current.claim)).capabilities.includes("inventory.identify"), true);
      const manager = await prisma.roleBundle.findUnique({ where: { id: "legacy-manager" } });
      assert.equal(manager?.capabilities.includes("inventory.identify"), false);
    });
    await suite.test("two administrators cannot restore access from a stale full user snapshot; every update requires target CAS", async () => {
      const second = await prisma.user.create({ data: { username: `${namespace}-second-admin`, displayName: "Synthetic second administrator", pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), role: "admin", roleBundles: { create: { bundleId: "legacy-admin" } } } });
      const signedIn = await identity.signInWithPassword({ username: second.username, password }, { source: `${namespace}-second-admin` });
      let otherActor = await principalFor(signedIn.claim);
      const setup = await mfa.beginMfaEnrollment(otherActor, { password }, context); await mfa.confirmMfaEnrollment(otherActor, { token: await generate({ secret: setup.secret }) }, context); otherActor = await principalFor(signedIn.claim);
      const created = await identity.createIdentityUser(actor, { username: `${namespace}-cas-target`, displayName: "Synthetic CAS target" });
      const enrollment = await identity.issueRecovery(actor, { userId: created.id, purpose: "enroll", reason: "Synthetic target enrolled before concurrent administration." }); await identity.redeemRecovery({ token: enrollment.token, password }, context);
      const live = await identity.signInWithPassword({ username: created.username, password }, context); const oldPrincipal = await principalFor(live.claim);
      const a = (await identity.listIdentityUsers(actor, created.username))[0], b = (await identity.listIdentityUsers(otherActor, created.username))[0]; assert.equal(a.authVersion, b.authVersion);
      const disabled = await identity.updateIdentityUser(otherActor, { id: created.id, expectedAuthVersion: b.authVersion, isActive: false, bundleIds: [] });
      assert.equal(disabled.authVersion, a.authVersion + 1); assert.equal(disabled.isActive, false);
      const stale = { id: a.id, expectedAuthVersion: a.authVersion, username: a.username, displayName: "Synthetic stale display-name-only intent", role: a.role, isActive: a.isActive, bundleIds: a.roleBundles.map(link => link.bundle.id) };
      await assert.rejects(identity.updateIdentityUser(actor, stale), (error: unknown) => error instanceof identity.IdentityError && error.status === 409);
      await assert.rejects(identity.updateIdentityUser(actor, { id: a.id, expectedAuthVersion: a.authVersion, displayName: "Synthetic stale partial update" }), (error: unknown) => error instanceof identity.IdentityError && error.status === 409);
      await assert.rejects(identity.updateIdentityUser(actor, { id: a.id, isActive: true }));
      const preserved = await prisma.user.findUniqueOrThrow({ where: { id: created.id }, include: { roleBundles: true } }); assert.equal(preserved.isActive, false); assert.equal(preserved.authVersion, disabled.authVersion); assert.equal(preserved.roleBundles.length, 0); assert.ok((await prisma.userSession.findUniqueOrThrow({ where: { id: live.claim.sessionId } })).revokedAt); await assert.rejects(identity.listSessions(oldPrincipal));
      const fresh = await identity.updateIdentityUser(actor, { id: preserved.id, expectedAuthVersion: preserved.authVersion, displayName: "Synthetic deliberate current update", isActive: true, bundleIds: ["legacy-user"] }); assert.equal(fresh.authVersion, preserved.authVersion + 1); assert.equal(fresh.isActive, true);
      const nextLogin = await identity.signInWithPassword({ username: fresh.username, password }, context); const nextPrincipal = await principalFor(nextLogin.claim);
      const renamed = await identity.updateIdentityUser(actor, { id: fresh.id, expectedAuthVersion: fresh.authVersion, displayName: "Synthetic current display-only update" }); assert.equal(renamed.authVersion, fresh.authVersion + 1); await assert.rejects(identity.listSessions(nextPrincipal), /access changed|session ended/);
    });
    await suite.test("custom bundle CAS rejects a second administrator's stale capabilities without revoking fresh access", async () => {
      const second = await prisma.user.create({ data: { username: `${namespace}-bundle-admin`, displayName: "Synthetic bundle administrator B", pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), role: "admin", roleBundles: { create: { bundleId: "legacy-admin" } } } });
      const loginB = await identity.signInWithPassword({ username: second.username, password }, { source: `${namespace}-bundle-admin` });
      let adminB = await principalFor(loginB.claim);
      const setupB = await mfa.beginMfaEnrollment(adminB, { password }, context); await mfa.confirmMfaEnrollment(adminB, { token: await generate({ secret: setupB.secret }) }, context); adminB = await principalFor(loginB.claim);
      const created = await identity.saveRoleBundle(actor, { name: `${namespace}-cas-bundle`, description: "Synthetic role reviewed by two administrators", capabilities: ["workflow.read", "workflow.execute"] });
      assert.match(created.fingerprint, /^[a-f0-9]{64}$/);
      const staleA = (await identity.listRoleBundles(actor)).find(bundle => bundle.id === created.id)!;
      assert.equal(staleA.fingerprint, created.fingerprint);
      const operator = await prisma.user.create({ data: { username: `${namespace}-bundle-operator`, displayName: "Synthetic assigned bundle operator", pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), role: "user", roleBundles: { create: { bundleId: created.id } } } });
      const oldLogin = await identity.signInWithPassword({ username: operator.username, password }, context);
      const oldPrincipal = await principalFor(oldLogin.claim); assert.equal(oldPrincipal.capabilities.includes("workflow.execute"), true);
      const reduced = await identity.saveRoleBundle(adminB, { id: created.id, expectedFingerprint: staleA.fingerprint, name: staleA.name, description: staleA.description, capabilities: ["workflow.read"] });
      assert.notEqual(reduced.fingerprint, staleA.fingerprint); assert.deepEqual(reduced.capabilities, ["workflow.read"]);
      assert.ok((await prisma.userSession.findUniqueOrThrow({ where: { id: oldLogin.claim.sessionId! } })).revokedAt);
      await assert.rejects(prisma.$transaction(tx => identity.assertCurrentPrincipal(tx, oldPrincipal, "workflow.execute")));
      const freshLogin = await identity.signInWithPassword({ username: operator.username, password }, context), freshPrincipal = await principalFor(freshLogin.claim);
      assert.equal(freshPrincipal.capabilities.includes("workflow.execute"), false);
      const beforeBundle = await prisma.roleBundle.findUniqueOrThrow({ where: { id: created.id } }), beforeUser = await prisma.user.findUniqueOrThrow({ where: { id: operator.id } }), beforeSession = await prisma.userSession.findUniqueOrThrow({ where: { id: freshLogin.claim.sessionId! } });
      await assert.rejects(identity.saveRoleBundle(actor, { id: created.id, expectedFingerprint: staleA.fingerprint, name: `${namespace}-stale-rename`, description: staleA.description, capabilities: staleA.capabilities }), (error: unknown) => error instanceof identity.IdentityError && error.status === 409);
      await assert.rejects(identity.saveRoleBundle(actor, { id: created.id, name: `${namespace}-missing-token`, capabilities: staleA.capabilities }), "An existing ID never falls through to the compatible create shape without a fingerprint");
      assert.deepEqual(await prisma.roleBundle.findUniqueOrThrow({ where: { id: created.id } }), beforeBundle);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: operator.id } })).authVersion, beforeUser.authVersion);
      assert.deepEqual(await prisma.userSession.findUniqueOrThrow({ where: { id: freshLogin.claim.sessionId! } }), beforeSession);
      assert.ok(await prisma.$transaction(tx => identity.assertCurrentPrincipal(tx, freshPrincipal, "workflow.read")));
      const fresh = (await identity.listRoleBundles(actor)).find(bundle => bundle.id === created.id)!;
      const deliberate = await identity.saveRoleBundle(actor, { id: fresh.id, expectedFingerprint: fresh.fingerprint, name: `${namespace}-fresh-bundle`, description: "Synthetic deliberate fresh review", capabilities: ["workflow.read", "workflow.execute"] });
      assert.notEqual(deliberate.fingerprint, fresh.fingerprint); assert.equal(deliberate.capabilities.includes("workflow.execute"), true);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: operator.id } })).authVersion, beforeUser.authVersion + 1);
      assert.ok((await prisma.userSession.findUniqueOrThrow({ where: { id: freshLogin.claim.sessionId! } })).revokedAt);
      const system = (await identity.listRoleBundles(actor)).find(bundle => bundle.id === "legacy-user")!;
      await assert.rejects(identity.saveRoleBundle(actor, { id: system.id, expectedFingerprint: system.fingerprint, name: system.name, description: system.description, capabilities: system.capabilities }), /system baseline/);
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
