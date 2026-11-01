import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's scrypt minimum alternative: N=2^15, r=8, p=3 (32 MiB).
// Fixed parameters are tied to the stored format version, never changed under
// an existing version. Benchmark the actual release host before rollout.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const KEY_LENGTH = 64;
const COMMON = new Set([
  "password", "passwordpassword", "passwordpasswordpassword", "password123456789",
  "123456789012345", "12345678901234567890", "qwertyuiopasdfgh", "letmeinletmeinletmein",
  "temcotoolstemcotools", "welcome123456789", "changemechangeme",
  "correct horse battery staple", "this is a password", "this is my password",
  "password1234567890", "welcome to temcotools",
]);

export class IdentityError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "IdentityError"; }
}

export function validatePassword(password: unknown, username = ""): asserts password is string {
  if (typeof password !== "string") throw new IdentityError("A password is required.");
  const length = [...password].length;
  if (length < 15 || length > 256 || Buffer.byteLength(password, "utf8") > 2048) {
    throw new IdentityError("Use a password or passphrase of 15 to 256 characters.");
  }
  const lower = password.toLocaleLowerCase("en-US").trim();
  if (COMMON.has(lower) || /^(.)\1+$/u.test(password) || (/^\d+$/.test(password))
    || (username.length >= 3 && lower === username.toLocaleLowerCase("en-US").repeat(Math.ceil(lower.length / username.length)).slice(0, lower.length))) {
    throw new IdentityError("Choose a less common password or a longer unique passphrase.");
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt-v2$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// A fixed synthetic hash path makes absent/legacy users perform the same KDF
// work. Passwords, salts and derived keys are never logged or returned by APIs.
const DUMMY_SALT = Buffer.alloc(16, 0x5a);
export async function verifyPassword(password: unknown, encoded: string | null | undefined): Promise<boolean> {
  const bounded = typeof password === "string" && Buffer.byteLength(password, "utf8") <= 2048;
  const parts = /^scrypt-v2\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded ?? "");
  const key = await derive(bounded ? password as string : "invalid-password-input", parts ? Buffer.from(parts[1], "base64url") : DUMMY_SALT);
  return Boolean(bounded && parts && timingSafeEqual(key, Buffer.from(parts[2], "base64url")));
}
