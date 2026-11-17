export const PASSWORD_MIN_LENGTH = 12;
export const SESSION_DAYS = 30;
export const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
export const ENROLLMENT_MS = 30 * 60 * 1000;
export const RECENT_AUTH_MS = 10 * 60 * 1000;
export class AuthError extends Error {
  constructor(message: string, public status = 400, public code = "AUTH_ERROR") { super(message); }
}
