import { cookies, headers } from "next/headers";
import { getIronSession } from "iron-session";
import type { PrismaClient } from "@prisma/client";
import { sessionOptions, type SessionData } from "@/lib/session";
import { isLivePersistentSession } from "@/lib/auth/principal";
import type { SiteDatabaseContext } from "./context";

export async function requestSiteContext(base: PrismaClient): Promise<SiteDatabaseContext | null> {
  let cookieStore: Awaited<ReturnType<typeof cookies>>;
  try { cookieStore = await cookies(); }
  catch (error) {
    if (error instanceof Error && /outside a request|outside a request scope/i.test(error.message)) return null;
    throw error;
  }
  const claim = await getIronSession<SessionData>(cookieStore, sessionOptions);
  if (!claim.userId || !claim.sessionId) return null;
  const session = await base.userSession.findUnique({ where: { id: claim.sessionId } });
  if (!session || !isLivePersistentSession(session, claim)) return null;
  const user = await base.user.findUnique({ where: { id: session.userId }, select: { id: true, isActive: true, authVersion: true, isPlatformAdmin: true } });
  if (!user?.isActive || user.authVersion !== session.authVersion) return null;
  const siteId = (await headers()).get("X-Temco-Site") || session.activeSiteId;
  if (!siteId || siteId.length > 200) return null;
  const site = await base.warehouseSite.findUnique({ where: { id: siteId } });
  if (!site?.isActive) return null;
  if (!user.isPlatformAdmin && !await base.warehouseMembership.findFirst({ where: { userId: user.id, siteId, isActive: true } })) return null;
  return { siteId, userId: user.id, sessionId: session.id, authVersion: user.authVersion };
}
