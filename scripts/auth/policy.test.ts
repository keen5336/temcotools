import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, validatePassword, verifyPassword } from "../../lib/auth/passwords";
import { ENROLLMENT_MS, SESSION_MS } from "../../lib/auth/policy";

test("password policy accepts 12 characters, spaces and Unicode without character-mix rules", () => {
  for (const value of ["cedar sunset", "a quiet cedar path", "abcdefghijkl", "🦓".repeat(11) + "x", "x".repeat(255) + "z"]) assert.doesNotThrow(() => validatePassword(value));
  for (const value of ["short words", "x".repeat(257), "🦓".repeat(11), "password1234", "123456789012", "Ashley1234567", "ashleyashley", "TemcoTools123!", "aaaaaaaaaaaa"]) assert.throws(() => validatePassword(value, "ashley"));
  assert.equal(SESSION_MS, 30 * 24 * 60 * 60_000);
  assert.equal(ENROLLMENT_MS, 30 * 60_000);
});
test("salted scrypt hashes verify exactly and fail safely for missing or malformed credentials", async () => {
  const value = "Synthetic cedar path 81";
  const first = await hashPassword(value), second = await hashPassword(value);
  assert.ok(first !== second); assert.ok(!first.includes(value));
  assert.ok(await verifyPassword(value, first));
  assert.ok(!await verifyPassword(value.toUpperCase(), first));
  assert.ok(!await verifyPassword(value, null));
  assert.ok(!await verifyPassword(value, "bad-hash"));
  assert.ok(!await verifyPassword({ password: value }, first));
  assert.ok(!await verifyPassword("x".repeat(2049), first));
});
