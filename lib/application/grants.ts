import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CAPABILITIES, CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";

const inputSchema = z.object({
  clientName: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  lifetimeMinutes: z.number().int().min(5).max(60).default(30),
});
const publicFields = { id: true, clientName: true, scopes: true, createdAt: true, expiresAt: true, revokedAt: true } as const;
export class GrantError extends Error { readonly status = 401; }
export const hashGrantToken = (token: string) => createHash("sha256").update(token).digest("hex");

// User-bound development/stdio grants; remote OAuth is a separate integration.
// No environment variable can assert a role or choose an arbitrary user ID.
export async function createAccessGrant(principal: Principal, input: unknown) {
  if (principal.grantId) throw new GrantError("Client grants cannot mint independent replacement grants. Use your own authenticated account to create a new client connection.");
  const data = inputSchema.parse(input);
  if (data.scopes.some((scope) => !principal.capabilities.includes(scope))) throw new GrantError("A grant cannot exceed your current permissions.");
  const token = `temco_${randomBytes(32).toString("base64url")}`;
  return prisma.$transaction(async (tx) => {
    const current = await assertCurrentPrincipal(tx, principal, "account.self");
    if (data.scopes.some(scope => !current.capabilities.includes(scope))) throw new GrantError("A grant cannot exceed current permissions.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`client-grants:${principal.userId}`}, 0))`;
    const activeCount = await tx.appAccessGrant.count({where:{userId:principal.userId,revokedAt:null,expiresAt:{gt:new Date()}}});
    if (activeCount >= 10) throw new GrantError("Revoke an existing client grant first.");
    const grant = await tx.appAccessGrant.create({data:{userId:principal.userId,sessionId:principal.sessionId,authVersion:principal.authVersion,tokenHash:hashGrantToken(token),clientName:data.clientName,scopes:[...new Set(data.scopes)],expiresAt:new Date(Date.now()+data.lifetimeMinutes*60_000)},select:publicFields});
    await tx.identityAudit.create({data:{action:"client_grant_created",actorUserId:principal.userId,sessionId:principal.sessionId,reason:data.clientName}});
    return {grant,token};
  });
}

export async function listAccessGrants(principal: Principal) {
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "account.self");
    return tx.appAccessGrant.findMany({where:{userId:principal.userId},select:publicFields,orderBy:{createdAt:"desc"},take:100});
  });
}
export async function revokeAccessGrant(principal: Principal, id: string) {
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "account.self");
    const result = await tx.appAccessGrant.updateMany({where:{id,userId:principal.userId,revokedAt:null},data:{revokedAt:new Date()}});
    if(result.count) await tx.identityAudit.create({data:{action:"client_grant_revoked",actorUserId:principal.userId,sessionId:principal.sessionId,reason:id}});
    return {revoked:result.count > 0};
  });
}
export async function authenticateAccessGrant(token: string): Promise<Principal> {
  if (!/^temco_[A-Za-z0-9_-]{43}$/.test(token)) throw new GrantError("A valid user client grant is required.");
  const grant = await prisma.appAccessGrant.findUnique({where:{tokenHash:hashGrantToken(token)}});
  if (!grant || grant.revokedAt || grant.audience !== "temcotools-mcp" || grant.expiresAt.getTime() <= Date.now()) throw new GrantError("Client grant expired or revoked.");
  if (!grant.sessionId) throw new GrantError("Recreate this legacy development grant from an individual session.");
  const session = await prisma.userSession.findUnique({where:{id:grant.sessionId}});
  const claim = session && {userId:session.userId,authVersion:session.authVersion,issuedAt:session.createdAt.getTime(),expiresAt:session.expiresAt.getTime(),sessionId:session.id};
  if (!session || !claim || session.userId !== grant.userId || session.authVersion !== grant.authVersion || !isLivePersistentSession(session,claim)) throw new GrantError("The issuing session ended or was locked.");
  const principal = await resolvePrincipal(claim, id => prisma.user.findUnique({where:{id},select:CURRENT_USER_SELECT}));
  if (!principal) throw new GrantError("The user session was revoked. Sign in again.");
  return {...principal,sessionId:session.id,grantId:grant.id,mfaVerifiedAt:session.mfaVerifiedAt?.getTime(),strongAuthenticatedAt:session.lastStrongAuthenticatedAt.getTime(),capabilities:principal.capabilities.filter(scope=>grant.scopes.includes(scope))};
}
