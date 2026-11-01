import assert from "node:assert/strict";
import test from "node:test";
import { isPrivilegedOAuthScope, knownOAuthScopes, oauthConfig, safeOAuthRedirect } from "../lib/oauth/config";

test("OAuth issuer and resource URLs are explicit and HTTPS except loopback tests", () => {
  const valid = oauthConfig({ issuerUrl: "https://temco.example", resourceUrl: "https://temco.example/mcp", appUrl: "https://temco.example" });
  assert.equal(valid.resourceUrl.pathname, "/mcp");
  assert.equal(oauthConfig({ issuerUrl: "http://127.0.0.1:3004", resourceUrl: "http://127.0.0.1:3004/mcp", appUrl: "http://127.0.0.1:3000" }).appUrl.port, "3000");
  for (const input of [
    { issuerUrl: "http://temco.example", resourceUrl: "http://temco.example/mcp", appUrl: "https://temco.example" },
    { issuerUrl: "https://temco.example/path", resourceUrl: "https://temco.example/mcp", appUrl: "https://temco.example" },
    { issuerUrl: "https://temco.example", resourceUrl: "https://elsewhere.example/mcp", appUrl: "https://temco.example" },
    { issuerUrl: "https://temco.example", resourceUrl: "https://temco.example/mcp?aud=other", appUrl: "https://temco.example" },
    { issuerUrl: "https://user:secret@temco.example", resourceUrl: "https://temco.example/mcp", appUrl: "https://temco.example" },
  ]) assert.throws(() => oauthConfig(input));
});

test("redirect registration rejects unsafe schemes, wildcards, embedded credentials and response parameters", () => {
  assert.equal(safeOAuthRedirect("https://client.example/callback"), "https://client.example/callback");
  assert.equal(safeOAuthRedirect("http://127.0.0.1:43210/callback"), "http://127.0.0.1:43210/callback");
  for (const uri of ["javascript:alert(1)", "http://client.example/callback", "https://*.example/callback", "https://user:secret@client.example/callback", "https://client.example/callback#fragment", "https://client.example/callback?code=chosen", "//evil.example/callback"]) assert.throws(() => safeOAuthRedirect(uri));
});

test("scope selection rejects unknown/duplicate grants and identifies sensitive approvals", () => {
  assert.equal(knownOAuthScopes(["inventory.read", "workflow.read"]), true);
  assert.equal(knownOAuthScopes([]), false);
  assert.equal(knownOAuthScopes(["inventory.read", "inventory.read"]), false);
  assert.equal(knownOAuthScopes(["invented.admin"]), false);
  assert.equal(isPrivilegedOAuthScope(["inventory.read", "labels.print"]), false);
  assert.equal(isPrivilegedOAuthScope(["users.manage"]), true);
  assert.equal(isPrivilegedOAuthScope(["office.authorize_rtv"]), true);
});
