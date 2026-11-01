import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const token = process.env.TEMCO_MCP_TOKEN;
  if (!token) throw new Error("Create a user-bound client grant in Temco Access, then supply TEMCO_MCP_TOKEN. Database access alone is not authorization.");
  const [{ createApplicationMcpServer }, { authenticateAccessGrant }] = await Promise.all([
    import("../lib/application/mcp"), import("../lib/application/grants"),
  ]);
  await authenticateAccessGrant(token);
  const server = createApplicationMcpServer(() => authenticateAccessGrant(token));
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  console.error("Temco MCP requires an active user-bound client grant and an available application database. No action was authorized.");
  process.exitCode = 1;
});
