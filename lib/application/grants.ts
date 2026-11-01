import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CAPABILITIES, resolvePrincipal, type Principal } from "@/lib/auth/principal";

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
  const data = inputSchema.parse(input);
  if (data.scopes.some((scope) => !principal.capabilities.includes(scope))) throw new GrantError("A grant cannot exceed your current permissions.");
  const token = `temco_${randomBytes(32).toString("base64url")}`;
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({where:{id:principal.userId},select:{authVersion:true,isActive:true}});
    if (!user?.isActive || user.authVersion !== principal.authVersion) throw new GrantError("Sign in again.");
    const activeCount = await tx.appAccessGrant.count({where:{userId:principal.userId,revokedAt:null,expiresAt:{gt:new Date()}}});
    if (activeCount >= 10) throw new GrantError("Revoke an existing client grant first.");
    const grant = await tx.appAccessGrant.create({data:{userId:principal.userId,authVersion:principal.authVersion,tokenHash:hashGrantToken(token),clientName:data.clientName,scopes:[...new Set(data.scopes)],expiresAt:new Date(Date.now()+data.lifetimeMinutes*60_000)},select:publicFields});
    return {grant,token};
  });
}

export async function listAccessGrants(principal: Principal) {
  return prisma.appAccessGrant.findMany({where:{userId:principal.userId},select:publicFields,orderBy:{createdAt:"desc"},take:100});
}
export async function revokeAccessGrant(principal: Principal, id: string) {
  const result = await prisma.appAccessGrant.updateMany({where:{id,userId:principal.userId,revokedAt:null},data:{revokedAt:new Date()}});
  return {revoked:result.count > 0};
}
export async function authenticateAccessGrant(token: string): Promise<Principal> {
  if (!/^temco_[A-Za-z0-9_-]{43}$/.test(token)) throw new GrantError("A valid user client grant is required.");
  const grant = await prisma.appAccessGrant.findUnique({where:{tokenHash:hashGrantToken(token)}});
  if (!grant || grant.revokedAt || grant.audience !== "temcotools-mcp" || grant.expiresAt.getTime() <= Date.now()) throw new GrantError("Client grant expired or revoked.");
  const principal = await resolvePrincipal({userId:grant.userId,authVersion:grant.authVersion,issuedAt:grant.createdAt.getTime(),expiresAt:grant.expiresAt.getTime(),sessionId:grant.id},id => prisma.user.findUnique({where:{id},select:{id:true,username:true,displayName:true,role:true,isActive:true,authVersion:true}}));
  if (!principal) throw new GrantError("The user session was revoked. Sign in again.");
  return {...principal,capabilities:principal.capabilities.filter(scope=>grant.scopes.includes(scope))};
}
