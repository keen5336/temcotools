// This module has no Next.js or database dependency. UI and MCP adapters resolve
// a principal from their verified credential, then use the same action checks.
export type UserRole = "admin" | "manager" | "user";

export const CAPABILITIES = [
  "inventory.read", "inventory.write", "inventory.identify", "workflow.read", "workflow.execute",
  "labels.read", "labels.print", "labels.manage", "users.manage",
  "files.manage", "payloads.manage", "diagnostics.use",
  "office.decide", "office.authorize_rtv",
  "account.self",
  "dispatch.allocate", "dispatch.signoff",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Principal {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  authVersion: number;
  capabilities: readonly Capability[];
  sessionId?: string;
  strongAuthenticatedAt?: number;
  mfaVerifiedAt?: number;
  grantId?: string;
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  authVersion: number;
  roleBundles?: Array<{ bundle: { capabilities: string[] } }>;
}

export interface SessionClaim {
  userId?: string;
  authVersion?: number;
  issuedAt?: number;
  expiresAt?: number;
  sessionId?: string;
}

export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const RECENT_AUTH_MS = 10 * 60 * 1000;
export const CURRENT_USER_SELECT = {
  id: true, username: true, displayName: true, role: true, isActive: true, authVersion: true,
  roleBundles: { select: { bundle: { select: { capabilities: true } } } },
} as const;
const COMMON_CAPABILITIES: readonly Capability[] = [
  "account.self",
  "inventory.read", "inventory.write", "workflow.read", "workflow.execute",
  "labels.read", "labels.print",
];

// These initial bundles preserve existing role access. New v2 approval and
// administration permissions must be assigned deliberately, not inferred from
// an old cookie or a client-supplied list.
export function capabilitiesForRole(role: UserRole): readonly Capability[] {
  if (role === "admin") return [...CAPABILITIES];
  if (role === "manager") return [...COMMON_CAPABILITIES, "labels.manage"];
  return [...COMMON_CAPABILITIES];
}

export function isLiveSessionClaim(claim: SessionClaim, now = Date.now()): boolean {
  return typeof claim.userId === "string" && claim.userId.length > 0 && claim.userId.length <= 200
    && Number.isSafeInteger(claim.authVersion) && claim.authVersion! > 0
    && typeof claim.sessionId === "string" && claim.sessionId.length >= 16 && claim.sessionId.length <= 100
    && Number.isSafeInteger(claim.issuedAt) && Number.isSafeInteger(claim.expiresAt)
    && claim.issuedAt! <= now + 5000
    && claim.issuedAt! >= 0 && claim.expiresAt! > now
    && claim.expiresAt! > claim.issuedAt!
    && claim.expiresAt! - claim.issuedAt! <= SESSION_MAX_AGE_MS;
}

export async function resolvePrincipal(
  claim: SessionClaim,
  lookup: (userId: string) => Promise<CurrentUser | null>,
  now = Date.now(),
): Promise<Principal | null> {
  if (!isLiveSessionClaim(claim, now)) return null;
  const user = await lookup(claim.userId!);
  if (!user || user.id !== claim.userId || !user.isActive || user.authVersion !== claim.authVersion) return null;
  if (user.role !== "admin" && user.role !== "manager" && user.role !== "user") return null;
  const assigned = user.roleBundles
    ? [...new Set(user.roleBundles.flatMap(({ bundle }) => bundle.capabilities))].filter((cap): cap is Capability => CAPABILITIES.includes(cap as Capability))
    : [...capabilitiesForRole(user.role)];
  return {
    userId: user.id, username: user.username, displayName: user.displayName,
    role: user.role, authVersion: user.authVersion,
    // An active person can always secure their own account, even if all
    // warehouse bundles are removed. Delegated grants still intersect scopes
    // and receive this capability only when it was explicitly granted.
    capabilities: [...new Set([...assigned, "account.self" as const])],
  };
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = "You do not have permission for this action.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function assertCapability(principal: Principal, capability: Capability): void {
  if (!principal.capabilities.includes(capability)) throw new AuthorizationError();
}

export function assertRecentPasswordAuthentication(principal: Principal, now = Date.now()): void {
  const at = principal.strongAuthenticatedAt;
  if (!principal.sessionId || !Number.isSafeInteger(at) || at! <= 0 || at! > now + 5000 || now - at! > RECENT_AUTH_MS) {
    throw new AuthorizationError("Confirm your password in Account security before this sensitive action.");
  }
}

export function assertRecentAuthentication(principal: Principal, now = Date.now()): void {
  assertRecentPasswordAuthentication(principal, now);
  const at = principal.mfaVerifiedAt;
  if (!Number.isSafeInteger(at) || at! <= 0 || at! > now + 5000 || now - at! > RECENT_AUTH_MS) {
    throw new AuthorizationError("Confirm an authenticator or recovery code with your password in Account security before this sensitive action.");
  }
}

export interface PersistentSession {
  id: string;
  userId: string;
  authVersion: number;
  expiresAt: Date;
  lastActivityAt: Date;
  lastStrongAuthenticatedAt: Date;
  mfaVerifiedAt?: Date | null;
  revokedAt: Date | null;
  lockedAt: Date | null;
}

export function isLivePersistentSession(session: PersistentSession, claim: SessionClaim, now = Date.now()): boolean {
  return isLiveSessionClaim(claim, now) && session.id === claim.sessionId
    && session.userId === claim.userId && session.authVersion === claim.authVersion
    && !session.revokedAt && !session.lockedAt && session.expiresAt.getTime() > now
    && session.expiresAt.getTime() === claim.expiresAt
    && session.lastActivityAt.getTime() <= now + 5000
    && now - session.lastActivityAt.getTime() < SESSION_IDLE_MS;
}
