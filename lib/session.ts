import type { SessionOptions } from "iron-session";
import { SESSION_MAX_AGE_MS, type Capability } from "@/lib/auth/principal";

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
  capabilities?: readonly Capability[];
  apiRelaySessionId?: string;
}

export const sessionOptions: SessionOptions = {
  cookieName: "temco_session",
  password: process.env.SESSION_SECRET!,
  ttl: SESSION_MAX_AGE_MS / 1000,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
};
