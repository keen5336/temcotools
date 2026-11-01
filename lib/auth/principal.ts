// This module has no Next.js or database dependency. UI and MCP adapters resolve
// a principal from their verified credential, then use the same action checks.
export type UserRole = "admin" | "manager" | "user";

export const CAPABILITIES = [
  "inventory.read", "inventory.write", "workflow.read", "workflow.execute",
  "labels.read", "labels.print", "labels.manage", "users.manage",
  "files.manage", "payloads.manage", "diagnostics.use",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Principal {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  authVersion: number;
  capabilities: readonly Capability[];
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  authVersion: number;
}

export interface SessionClaim {
  userId?: string;
  authVersion?: number;
  issuedAt?: number;
  expiresAt?: number;
  sessionId?: string;
}

export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const COMMON_CAPABILITIES: readonly Capability[] = [
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
  return {
    userId: user.id, username: user.username, displayName: user.displayName,
    role: user.role, authVersion: user.authVersion, capabilities: capabilitiesForRole(user.role),
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
