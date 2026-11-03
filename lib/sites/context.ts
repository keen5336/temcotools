import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "@/lib/auth/principal";

export type SiteDatabaseContext = { siteId: string; userId: string; sessionId: string; authVersion: number };
const storage = new AsyncLocalStorage<SiteDatabaseContext | null>();
export function currentSiteContext() { return storage.getStore(); }
export function withSiteContext<T>(context: SiteDatabaseContext | null, run: () => T): T { return storage.run(context, run); }
export function withPrincipalSite<T>(principal: Principal, run: () => T): T {
  return withSiteContext(principal.siteId && principal.sessionId ? { siteId: principal.siteId, userId: principal.userId, sessionId: principal.sessionId, authVersion: principal.authVersion } : null, run);
}
