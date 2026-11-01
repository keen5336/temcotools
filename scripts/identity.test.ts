import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, validatePassword, verifyPassword } from "../lib/auth/passwords";
import {
  assertRecentAuthentication, AuthorizationError, capabilitiesForRole,
  isLivePersistentSession, resolvePrincipal, SESSION_IDLE_MS, SESSION_MAX_AGE_MS,
  type PersistentSession, type Principal, type SessionClaim,
} from "../lib/auth/principal";

test("passwords support long Unicode passphrases and verify their full suffix beyond bcrypt's byte limit", async () => {
  const password = "仓库 operations " + "synthetic phrase ".repeat(8) + "first suffix";
  validatePassword(password);
  const encoded = await hashPassword(password);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword(password.replace("first suffix", "other suffix"), encoded), false);
  assert.equal(await verifyPassword(password, "$2b$12$legacy-placeholder"), false);
});

test("password policy rejects short, obvious, all-digit and overlong values without truncation", () => {
  for (const password of ["1234", "passwordpassword", "12345678901234567890", "x".repeat(30), "x".repeat(257)]) {
    assert.throws(() => validatePassword(password));
  }
  validatePassword("A synthetic correct horse phrase 🏭");
});

test("scrypt uses distinct salts and never accepts malformed or absent hashes", async () => {
  const password = "Synthetic specimen passphrase 7";
  assert.notEqual(await hashPassword(password), await hashPassword(password));
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword("x".repeat(4096), null), false);
});

test("server sessions enforce individual revoke, lock, idle and exact absolute expiry", () => {
  const now = Date.now();
  const claim: SessionClaim = { userId: "user-a", authVersion: 1, sessionId: "synthetic-session-a", issuedAt: now - 1000, expiresAt: now - 1000 + SESSION_MAX_AGE_MS };
  const session: PersistentSession = {
    id: claim.sessionId!, userId: claim.userId!, authVersion: 1, expiresAt: new Date(claim.expiresAt!),
    lastActivityAt: new Date(now - 1000), lastStrongAuthenticatedAt: new Date(now - 1000), revokedAt: null, lockedAt: null,
  };
  assert.equal(isLivePersistentSession(session, claim, now), true);
  for (const invalid of [
    { ...session, revokedAt: new Date(now) }, { ...session, lockedAt: new Date(now) },
    { ...session, lastActivityAt: new Date(now - SESSION_IDLE_MS) },
    { ...session, expiresAt: new Date(now - 1) }, { ...session, authVersion: 2 },
    { ...session, userId: "user-b" },
  ]) assert.equal(isLivePersistentSession(invalid, claim, now), false);
});

test("recent authentication requires a current session and bounded strong-auth timestamp", () => {
  const now = Date.now();
  const principal: Principal = { userId: "user-a", username: "a", displayName: "A", role: "admin", authVersion: 1, capabilities: [], sessionId: "session-a", strongAuthenticatedAt: now - 1000, mfaVerifiedAt: now - 1000 };
  assertRecentAuthentication(principal, now);
  for (const invalid of [{ ...principal, sessionId: undefined }, { ...principal, strongAuthenticatedAt: undefined }, { ...principal, strongAuthenticatedAt: NaN }, { ...principal, strongAuthenticatedAt: now - 11 * 60_000 }, { ...principal, strongAuthenticatedAt: now + 60_000 }]) {
    assert.throws(() => assertRecentAuthentication(invalid, now), AuthorizationError);
  }
});

test("multiple current bundles grant a union; empty assignments fail closed and unknown caps are ignored", async () => {
  const now = Date.now();
  const claim = { userId: "user-a", authVersion: 1, sessionId: "synthetic-session-a", issuedAt: now - 1000, expiresAt: now + 60_000 };
  const user = { id: "user-a", username: "a", displayName: "A", role: "user" as const, isActive: true, authVersion: 1 };
  const principal = await resolvePrincipal(claim, async () => ({ ...user, roleBundles: [{ bundle: { capabilities: ["inventory.read"] } }, { bundle: { capabilities: ["inventory.identify", "inventory.read", "invented.admin"] } }] }), now);
  assert.deepEqual(principal?.capabilities, ["inventory.read", "inventory.identify"]);
  assert.deepEqual((await resolvePrincipal(claim, async () => ({ ...user, roleBundles: [] }), now))?.capabilities, []);
  assert.equal(capabilitiesForRole("manager").includes("inventory.identify"), false);
});
