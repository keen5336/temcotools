import type { SessionOptions } from "iron-session";

export interface SessionData {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  isActive: boolean;
}

export const sessionOptions: SessionOptions = {
  cookieName: "temco_session",
  password: process.env.SESSION_SECRET!,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
};
