import type { IntegrationActionDefinition } from "./definition";

// Representative wiring ONLY. These names/paths/fields are not a Descartes
// contract, and preview never registers, publishes, pairs or sends this request.
export const WMS_LPN_FIXTURE: IntegrationActionDefinition = {
  integrationId: "synthetic-wms", key: "fixture.lpn", name: "Synthetic LPN inquiry · no WMS call",
  adapterId: "synthetic-http", adapterVersion: 1,
  origin: "https://wms-fixture.example.invalid", pagePathPrefix: "/fixture/portal",
  effect: "read", requiredCapability: "inventory.read",
  inputs: { lpn: { type: "string", maxLength: 80 } },
  output: { type: "object", fields: {
    lpn: { type: "string", maxLength: 80 },
    warehouse: { type: "string", maxLength: 80 },
    reportedStatus: { type: "string", maxLength: 80 },
  } },
  request: { method: "GET", path: "/fixture/lpn", query: {
    lpn: { from: "input", path: ["lpn"] }, warehouse: { from: "warehouse" },
  } },
  limits: { timeoutMs: 10000, maxInputBytes: 8192, maxResponseBytes: 65536,
    maxConcurrent: 1, maxQueued: 3, heartbeatMaxAgeMs: 20000, identityMaxAgeMs: 60000 },
};
export const WMS_LPN_SAMPLE = { lpn: "SYNTHETIC-LPN-0001" };
export const WMS_LPN_OUTPUT = { ...WMS_LPN_SAMPLE, warehouse: "SYNTHETIC_PREVIEW_WAREHOUSE", reportedStatus: "FIXTURE_ONLY" };
