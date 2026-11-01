import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { GrantError } from "./grants";
import { getMarsStatusRules, getMarsUnit, getMarsWorkflowSummary, searchMarsUnits } from "./mars-queries";
import { MARS_OPERATIONAL_BUCKETS } from "@/lib/mars/classification";
import { lookupWarehouseInventory } from "@/lib/warehouse-lookup";

export function createApplicationMcpServer(authenticate: () => Promise<Principal>) {
  const server = new McpServer({ name: "temcotools", version: "2.0.0-development" });
  async function execute(action: (principal: Principal) => unknown | Promise<unknown>) {
    try {
      const value = await action(await authenticate());
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      const known = error instanceof AuthorizationError || error instanceof GrantError || error instanceof z.ZodError;
      return { isError: true, content: [{ type: "text" as const, text: known ? "The current user/client is not authorized or the input is invalid." : "The action could not be completed." }] };
    }
  }
  server.registerTool("warehouse_lookup", {
    title: "Find warehouse inventory", description: "Look up one exact WMS LPN or list order candidates. A report row does not prove physical stock.",
    inputSchema: { kind: z.enum(["lpn", "order"]), value: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() },
  }, input => execute(principal => lookupWarehouseInventory(principal, input)));
  server.registerTool("mars_workflow_summary", { title: "MARS workflow summary", description: "Imported MARS workflow counts; current user authorization required.", inputSchema: {} }, () => execute(getMarsWorkflowSummary));
  server.registerTool("mars_search_units", {
    title: "Search MARS submissions", description: "Search existing submissions; order is context, not physical-unit identity.",
    inputSchema: { query: z.string().max(200).optional(), bucket: z.enum(MARS_OPERATIONAL_BUCKETS).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, input => execute(principal => searchMarsUnits(principal, { ...input, limit: input.limit ?? 25 })));
  server.registerTool("mars_get_unit", { title: "Get MARS submission", description: "Get existing submission by request number.", inputSchema: { requestNumber: z.string().trim().min(1).max(200) } }, input => execute(principal => getMarsUnit(principal, input.requestNumber)));
  server.registerTool("mars_problem_units", { title: "MARS problem submissions", description: "List imported MARS problems.", inputSchema: { limit: z.number().int().min(1).max(100).optional() } }, input => execute(principal => searchMarsUnits(principal, { bucket: "problem", limit: input.limit ?? 50 })));
  server.registerTool("mars_status_rules", { title: "MARS classification guidance", description: "Explain imported classification versus physical evidence.", inputSchema: {} }, () => execute(getMarsStatusRules));
  return server;
}
