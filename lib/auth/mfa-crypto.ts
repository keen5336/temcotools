import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { IdentityError } from "./passwords";

function encryptionKey() {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (configured) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(configured)) throw new IdentityError("MFA encryption key configuration is invalid.", 503);
    const key = Buffer.from(configured, "base64url");
    if (key.length !== 32) throw new IdentityError("MFA encryption key configuration is invalid.", 503);
    return key;
  }
  const secret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" || !secret || secret.length < 32) {
    throw new IdentityError("Configure the application MFA encryption key before authenticator enrollment.", 503);
  }
  // Local development only. Production uses a separate preserved 32-byte key,
  // so rotating the cookie key cannot silently destroy enrolled authenticators.
  return createHmac("sha256", secret).update("temco:totp-secret-encryption:v1").digest();
}

export function encryptMfaSecret(userId: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`temco:mfa:v1:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["mfa-v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptMfaSecret(userId: string, envelope: string): string {
  try {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== "mfa-v1" || !/^[A-Za-z0-9_-]{16}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{1,200}$/.test(parts[3])) throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(`temco:mfa:v1:${userId}`));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new IdentityError("Authenticator verification is unavailable. Check the preserved MFA key or use the authorized recovery procedure.", 503);
  }
}

export function normalizeMfaRecoveryCode(code: string): string {
  const normalized = code.replace(/[\s-]/g, "").toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(normalized)) throw new IdentityError("Authenticator or recovery code is invalid or already used.", 401);
  return normalized;
}

export function hashMfaRecoveryCode(userId: string, code: string): string {
  return createHash("sha256").update(`temco:mfa-recovery:v1:${userId}:${normalizeMfaRecoveryCode(code)}`).digest("hex");
}

export function generateMfaRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(12).toString("hex").match(/.{6}/g)!.join("-"));
}
