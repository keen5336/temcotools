import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthError, PASSWORD_MIN_LENGTH } from "./policy";

const COMMON = new Set([
  "password", "password1234", "password12345", "password123456", "passwordpassword",
  "123456789012", "1234567890123", "123456789012345", "qwertyuiop12", "qwertyuiopasdfgh",
  "letmeinletmein", "welcome12345", "welcome123456", "changeme1234", "changemechangeme",
  "temcotools123", "temcotoolstemcotools", "welcome to temcotools", "this is a password",
  "correct horse battery staple", "this is my password", "adminadmin12", "administrator",
]);
export function validatePassword(value: unknown, username = ""): asserts value is string {
  if (typeof value !== "string" || [...value].length < PASSWORD_MIN_LENGTH || [...value].length > 256 || Buffer.byteLength(value) > 2048) throw new AuthError("Use a password or passphrase of 12–256 characters.");
  const lower = value.toLowerCase().trim();
  const account = username.trim().toLowerCase();
  const base = lower.replace(/^[\d\W_]+|[\d\W_]+$/gu, "");
  const obvious = ["password", "welcome", "changeme", "letmein", "qwerty", "administrator", "temco", "temcotools", ...(account.length >= 3 ? [account] : [])];
  if (COMMON.has(lower) || /^(.)\1+$/u.test(value) || obvious.includes(base) || (account.length >= 3 && lower === account.repeat(Math.ceil(lower.length / account.length)).slice(0, lower.length))) throw new AuthError("Choose a less common password or a unique passphrase.");
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = randomBytes(16), key = await derive(password, salt);
  return `scrypt-v1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(password: unknown, encoded?: string | null) {
  const valid = typeof password === "string" && Buffer.byteLength(password) <= 2048;
  const parts = /^scrypt-v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded || "");
  const key = await derive(valid ? password as string : "invalid-password-input", parts ? Buffer.from(parts[1], "base64url") : Buffer.alloc(16, 0x5a));
  return Boolean(valid && parts && timingSafeEqual(key, Buffer.from(parts[2], "base64url")));
}
