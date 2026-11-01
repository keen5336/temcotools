import { createMcpHttpApp } from "../lib/oauth/http-server";
import { oauthConfig } from "../lib/oauth/config";

function main() {
  const config = oauthConfig();
  const port = Number(process.env.MCP_HTTP_PORT || "3004");
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP_HTTP_PORT.");
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("MCP_HTTP_HOST must be loopback or an explicitly configured private-container interface.");
  const { app } = createMcpHttpApp(config);
  const server = app.listen(port, host, () => { console.log(`TemcoTools authenticated MCP listening on ${host}:${port}.`); });
  const stop = () => { server.close(() => { process.exitCode = 0; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
try { main(); } catch { console.error("Authenticated MCP did not start. Check explicit issuer/resource/application URLs, migrations and private runtime configuration."); process.exitCode = 1; }
