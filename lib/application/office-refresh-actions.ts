import { advanceOfficeRefresh, advanceOfficeRefreshInputSchema, getOfficeRefreshStatus, officeRefreshStatusInputSchema } from "@/lib/office/refresh";
export const officeRefreshActions = {
  "office.refresh.status": { capabilitiesAny: ["workflow.read", "inventory.write", "office.decide"], description: "Inspect local Office evaluation coverage, fixed run cursor and source/day freshness; this does not refresh upstream data", inputSchema: officeRefreshStatusInputSchema, run: getOfficeRefreshStatus },
  "office.refresh.advance": { capabilitiesAny: ["inventory.write", "office.decide"], description: "Evaluate one bounded page under the current actor and append its deterministic receipt; resume the returned fixed run until complete, without physical or external actions", inputSchema: advanceOfficeRefreshInputSchema, run: advanceOfficeRefresh },
} as const;
