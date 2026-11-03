/** Pilot application relay entrypoint. Production's legacy server.mjs remains usable. */
import { pathToFileURL } from "node:url";
import { createApiRelayServer, createDmpAuthorizationCallback } from "./server.mjs";
import { createGenericProviderHub } from "./generic-provider.mjs";
import { createProviderRuntime, providerRuntimeAudience, deriveProviderRuntimeReportSecret } from "@/lib/integrations/provider-runtime";

export function createApplicationRelay() {
  const secret = process.env.SESSION_SECRET;
  const legacyAudience = process.env.API_RELAY_AUDIENCE;
  const audience = providerRuntimeAudience();
  if (!secret || secret.length < 32 || !legacyAudience || !audience) throw new Error("A private relay session key and explicit audience are required.");
  // A separate protocol namespace, never sent to a page, client or report body.
  const reportSecret = deriveProviderRuntimeReportSecret(audience);
  const mode = process.env.TEMCO_PILOT_MODE === "read_only_dmp" ? "read_only_dmp" : "live";
  const runtime = createProviderRuntime({ audience, mode, reportSecret });
  const hub = createGenericProviderHub({ audience, mode, authorize: runtime.authorize, operations: runtime.operations, observe: async event => { await runtime.observe(event); } });
  return createApiRelayServer({ secret, audience: legacyAudience, allowedOrigins: (process.env.DMP_ORIGINS ?? "https://dmp.extapps.homedepot.com").split(",").map(s => s.trim()).filter(Boolean), authorize: createDmpAuthorizationCallback(), genericProviderHub: hub });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createApplicationRelay();
  relay.server.listen(Number(process.env.API_RELAY_PORT || 3003), process.env.API_RELAY_HOST || "127.0.0.1", () => console.log("Application browser relay listening"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
}
