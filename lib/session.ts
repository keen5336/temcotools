import type { SessionOptions } from "iron-session";
import { SESSION_MAX_AGE_MS, type Capability } from "@/lib/auth/principal";
import { pilotPolicy } from "../scripts/pilot-policy.mjs";

export interface SessionData {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "manager" | "user";
  isActive: boolean;
  authVersion?: number;
  issuedAt?: number;
  expiresAt?: number;
  sessionId?: string;
  strongAuthenticatedAt?: number;
  mfaVerifiedAt?: number;
  capabilities?: readonly Capability[];
  apiRelaySessionId?: string;
}

const cookieName = process.env.TEMCO_SESSION_COOKIE_NAME || "temco_session";
if (!/^[A-Za-z0-9_-]{1,80}$/.test(cookieName) || (pilotPolicy().isolated && cookieName === "temco_session")) throw new Error("Configure a distinct valid pilot session cookie name.");
export const sessionOptions: SessionOptions = {
  cookieName,
  password: process.env.SESSION_SECRET!,
  ttl: SESSION_MAX_AGE_MS / 1000,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  },
};
