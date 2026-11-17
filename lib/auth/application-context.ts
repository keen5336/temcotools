import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionData } from "@/lib/session";

// Only trusted server adapters install this callback. No request header/body can
// choose a principal; the callback revalidates the bearer grant on every access.
const context = new AsyncLocalStorage<() => Promise<SessionData>>();
export function applicationSessionResolver() { return context.getStore(); }
export function withApplicationSession<T>(resolve: () => Promise<SessionData>, work: () => Promise<T>) { return context.run(resolve, work); }
