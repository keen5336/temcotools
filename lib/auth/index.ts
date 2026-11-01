import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionOptions, type SessionData } from "@/lib/session";
import { prisma } from "@/lib/db";
import { resolvePrincipal, type Principal } from "./principal";

export async function getSession() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  const principal = await resolvePrincipal(session, (id) => prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, displayName: true, role: true, isActive: true, authVersion: true },
  }));
  if (principal) {
    // These values are always refreshed from the authoritative user, not saved
    // cookie snapshots. No cookie write is required in a Server Component.
    session.username = principal.username;
    session.displayName = principal.displayName;
    session.role = principal.role;
    session.isActive = true;
    session.capabilities = principal.capabilities;
  } else {
    // Keep the IronSession methods for existing route compatibility. Clearing
    // the in-memory identity fails closed even where code checks only userId.
    session.userId = "";
    session.username = "";
    session.displayName = "";
    session.role = "user";
    session.isActive = false;
    session.capabilities = [];
    delete session.apiRelaySessionId;
  }
  return session;
}

export async function getCurrentPrincipal(): Promise<Principal | null> {
  const session = await getSession();
  if (!session.userId || !session.isActive || !session.authVersion) return null;
  return {
    userId: session.userId, username: session.username, displayName: session.displayName,
    role: session.role, authVersion: session.authVersion, capabilities: session.capabilities ?? [],
  };
}

export const getPrincipal = getCurrentPrincipal;

export async function requireAuth() {
  const session = await getSession();
  if (!session.userId) {
    redirect("/signin");
  }
  if (!session.isActive) {
    redirect("/signin?error=inactive");
  }
  return session;
}

export async function requireAdmin() {
  const session = await requireAuth();
  if (session.role !== "admin") {
    redirect("/");
  }
  return session;
}

export async function requireManager() {
  const session = await requireAuth();
  if (session.role !== "admin" && session.role !== "manager") {
    redirect("/");
  }
  return session;
}
