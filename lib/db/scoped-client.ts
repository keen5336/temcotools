import type { Prisma, PrismaClient } from "@prisma/client";
import { currentSiteContext, type SiteDatabaseContext } from "@/lib/sites/context";

type Operation = (...args: unknown[]) => unknown;
type Client = Record<string, unknown>;
export function createScopedClient(base: PrismaClient, resolve: () => Promise<SiteDatabaseContext | null>): PrismaClient {
  async function transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>, options?: object): Promise<T> {
    const context = currentSiteContext() === undefined ? await resolve() : currentSiteContext();
    return base.$transaction(async tx => {
      // FORCE RLS does not constrain a superuser. Always assume the explicitly
      // restricted runtime role, including development clients using owner DSNs.
      await tx.$executeRawUnsafe("SET LOCAL ROLE temco_runtime");
      await tx.$queryRaw`SELECT set_config('temco.site_id', ${context?.siteId ?? ""}, true), set_config('temco.user_id', ${context?.userId ?? ""}, true), set_config('temco.session_id', ${context?.sessionId ?? ""}, true), set_config('temco.auth_version', ${context ? String(context.authVersion) : ""}, true)`;
      return run(tx);
    }, options);
  }
  const delegates = new Map<string, unknown>();
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === "$transaction") return (run: unknown, options?: object) => {
        if (typeof run !== "function") throw new Error("Use an interactive transaction so warehouse context is bound before its queries.");
        return transaction(run as (tx: Prisma.TransactionClient) => Promise<unknown>, options);
      };
      if (typeof key === "string" && ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"].includes(key)) {
        return (...args: unknown[]) => transaction(tx => ((tx as unknown as Client)[key] as Operation).apply(tx, args) as Promise<unknown>);
      }
      const value = Reflect.get(target, key, receiver);
      if (typeof key === "string" && !key.startsWith("$") && value && typeof value === "object" && "findMany" in value) {
        if (!delegates.has(key)) delegates.set(key, new Proxy(value, { get(delegate, method) {
          const fn = Reflect.get(delegate, method);
          if (typeof fn !== "function") return fn;
          return (...args: unknown[]) => transaction(tx => {
            const model = (tx as unknown as Client)[key] as Client;
            return (model[method as string] as Operation).apply(model, args) as Promise<unknown>;
          });
        } }));
        return delegates.get(key);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
