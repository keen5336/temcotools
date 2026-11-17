import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_ACTIONS, ACTIONS } from "../../lib/mcp/catalog";
import { clientMetadata, metadataCacheMs, publicClientMetadata, publicMetadataAddress } from "../../lib/mcp/clients";
import { parseScopes, redirectMatches, safeRedirect, safeReturnTo } from "../../lib/mcp/config";

test("OAuth callbacks, public metadata fetching and scopes deny unsafe destinations", () => {
  for (const uri of ["https://client.example/callback", "http://127.0.0.1:39125/callback", "http://[::1]:39125/callback"]) assert.doesNotThrow(() => safeRedirect(uri));
  for (const uri of ["javascript:alert(1)", "http://client.example/callback", "https://user:pass@client.example/cb", "https://*.example/cb", "https://client.example/cb#token", "https://client.example/cb?code=x"]) assert.throws(() => safeRedirect(uri));
  assert.ok(redirectMatches("http://127.0.0.1:3000/callback", "http://127.0.0.1:4000/callback"));
  assert.ok(!redirectMatches("https://client.example/a", "https://client.example/b"));
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) assert.ok(!publicMetadataAddress(address));
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.ok(publicMetadataAddress(address));
  assert.throws(() => parseScopes("temco.read unknown")); assert.throws(() => parseScopes("temco.write"));
  assert.throws(() => clientMetadata({ client_name: "Bad", redirect_uris: ["https://client.example/cb#x"] }));
  assert.equal(safeReturnTo("//evil.example"), "/"); assert.equal(safeReturnTo("/\\evil.example"), "/");
  assert.equal(safeReturnTo("/account/mcp/authorize?requestId=x"), "/account/mcp/authorize?requestId=x");
  assert.equal(metadataCacheMs("no-store"),0);assert.equal(metadataCacheMs("public, max-age=60"),60000);assert.equal(metadataCacheMs("max-age=99999999"),3600000);
});

test("catalog is unique and locks relay action names instead of accepting an arbitrary dispatch path", () => {
  assert.equal(new Set(ALL_ACTIONS.map(action => action.name)).size, ALL_ACTIONS.length);
  assert.ok(ALL_ACTIONS.length >= 85);
  for (const action of ACTIONS.filter(action => action.path === "/api/api-relay/[action]")) {
    assert.ok(action.fixedParams?.action);
    assert.ok(!action.schema.safeParse({ params: { action: "pair" }, body: {} }).success);
  }
  assert.equal(ALL_ACTIONS.find(action => action.name === "users.setup_code")!.mode, "browser");
  assert.equal(ALL_ACTIONS.find(action => action.name === "account.password")!.mode, "browser");
});

test("every API route is catalogued or explicitly covered by a protocol/browser ceremony", async () => {
  const exceptions = new Map([
    ["POST /api/auth/login", "Human password/PIN entry"], ["POST /api/auth/update", "Human account enrollment"], ["POST /api/auth/logout", "account.sign_out revokes the current MCP device"],
    ["POST /api/admin/account-codes", "users.setup_code protects private credentials in the browser"], ["POST /api/account/security", "account.password and account.devices.revoke"],
    ["GET /api/label-relay/session", "Relay authentication protocol; labels.print is the user action"], ["GET /api/api-relay/loader", "relays.activate is the browser handoff"],
    ["POST /api/internal/relay-authorization", "Private broker protocol"], ["POST /api/account/mcp/consent", "Explicit browser consent, never agent self-approval"], ["GET /api/account/mcp/downloads/[id]", "mcp.artifact and authenticated resource downloads"],
  ]);
  const mapped = new Set(ACTIONS.map(action => `${action.method} ${action.path}`));
  async function visit(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.name === "route.ts") {
        const source = await readFile(file, "utf8"), route = "/" + path.replace(/^app\//, "");
        const methods = [...source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)/g)].map(value => value[1]);
        for (const method of methods) assert.ok(mapped.has(`${method} ${route}`) || exceptions.has(`${method} ${route}`), `Missing MCP coverage: ${method} ${route}`);
      }
    }
  }
  await visit("app/api");
});


test("OpenAI CIMD negotiation accepts public PKCE despite a legacy JWT preference", () => {
  const id = "https://client.example/oauth/client.json";
  const common = { client_id: id, client_name: "Synthetic ChatGPT", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "private_key_jwt" };
  assert.equal(publicClientMetadata({ ...common, token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] }, id).token_endpoint_auth_method, "none");
  assert.throws(() => publicClientMetadata(common, id));
  assert.throws(() => publicClientMetadata({ ...common, token_endpoint_auth_methods_supported: ["private_key_jwt"] }, id));
  assert.throws(() => publicClientMetadata({ ...common, token_endpoint_auth_methods_supported: ["none"] }, "https://other.example/client.json"));
  assert.deepEqual(parseScopes("temco.read offline_access"), ["temco.read", "offline_access"]);
});
