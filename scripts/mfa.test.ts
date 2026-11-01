import assert from "node:assert/strict";
import test from "node:test";
import { generate, verify } from "otplib";
import { decryptMfaSecret, encryptMfaSecret, generateMfaRecoveryCodes, hashMfaRecoveryCode } from "../lib/auth/mfa-crypto";
import { verifyTotpStep } from "../lib/auth/totp";
import { assertRecentAuthentication, type Principal } from "../lib/auth/principal";

const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
test("maintained TOTP implementation matches RFC 6238 SHA-1 vectors", async () => {
  for (const [epoch, expected] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
    assert.equal(await generate({ secret: rfcSecret, epoch, digits: 8, algorithm: "sha1", period: 30 }), expected);
    assert.equal((await verify({ strategy: "totp", secret: rfcSecret, epoch, digits: 8, token: expected })).valid, true);
  }
});

test("application TOTP accepts current/past skew, rejects future and already-used steps", async () => {
  const epoch = 1234567890;
  const token = await generate({ secret: rfcSecret, epoch });
  const step = await verifyTotpStep(rfcSecret, token, -1, epoch * 1000);
  assert.equal(step, Math.floor(epoch / 30));
  await assert.rejects(verifyTotpStep(rfcSecret, token, step, epoch * 1000));
  const past = await generate({ secret: rfcSecret, epoch: epoch - 30 });
  assert.equal(await verifyTotpStep(rfcSecret, past, -1, epoch * 1000), step - 1);
  const future = await generate({ secret: rfcSecret, epoch: epoch + 30 });
  await assert.rejects(verifyTotpStep(rfcSecret, future, -1, epoch * 1000));
});

test("authenticator secrets use authenticated encryption bound to the account", () => {
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x4d).toString("base64url");
  const encrypted = encryptMfaSecret("synthetic-user-a", rfcSecret);
  assert.equal(encrypted.includes(rfcSecret), false);
  assert.equal(decryptMfaSecret("synthetic-user-a", encrypted), rfcSecret);
  assert.throws(() => decryptMfaSecret("synthetic-user-b", encrypted));
  const parts = encrypted.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  assert.throws(() => decryptMfaSecret("synthetic-user-a", parts.join(".")));
});

test("recovery codes are unique and hashed per account with normalized manual entry", () => {
  const codes = generateMfaRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.equal(hashMfaRecoveryCode("user-a", codes[0]), hashMfaRecoveryCode("user-a", codes[0].toUpperCase().replace(/-/g, " ")));
  assert.notEqual(hashMfaRecoveryCode("user-a", codes[0]), hashMfaRecoveryCode("user-b", codes[0]));
  assert.throws(() => hashMfaRecoveryCode("user-a", "invalid"));
});

test("privileged recency requires both password and second factor on a current session", () => {
  const now = Date.now();
  const actor: Principal = { userId: "user-a", username: "a", displayName: "A", role: "admin", authVersion: 1, capabilities: [], sessionId: "session-a", strongAuthenticatedAt: now, mfaVerifiedAt: now };
  assertRecentAuthentication(actor, now);
  for (const candidate of [{ ...actor, mfaVerifiedAt: undefined }, { ...actor, mfaVerifiedAt: now - 11 * 60_000 }, { ...actor, strongAuthenticatedAt: now - 11 * 60_000 }, { ...actor, mfaVerifiedAt: NaN }]) assert.throws(() => assertRecentAuthentication(candidate, now));
});
