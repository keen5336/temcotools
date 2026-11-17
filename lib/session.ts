import type { SessionOptions } from "iron-session";
import { SESSION_MS } from "@/lib/auth/policy";

export interface SessionData {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "manager" | "user";
  isActive: boolean;
  apiRelaySessionId?: string;
  sessionId?: string;
  authVersion?: number;
  expiresAt?: number;
  reauthenticatedAt?: number;
  upgradeRequired?: boolean;
  upgradeUsername?: string;
}

export const sessionOptions: SessionOptions = {
  cookieName: "temco_session",
  password: process.env.SESSION_SECRET!,
  ttl: SESSION_MS / 1000,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
};
