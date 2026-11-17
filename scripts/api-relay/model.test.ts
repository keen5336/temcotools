import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RELAY_PROGRAM, exactRelayOrigin, exactRelayPath, relayDefinitionsOverlap, resolveRelayDefinition, validateRelayFields, type RelayDefinition } from "../../lib/api-relay/model";
import { buildRelayRequest } from "../../lib/api-relay/config";
import { connectTemcoBookmarklet } from "../../lib/api-relay/bookmarklet";

export const sampleRelay: RelayDefinition = { id: "warehouse", name: "Warehouse", enabled: true, origins: ["https://warehouse.test"], pathPrefix: "/ops", identityPath: "/api/me", subjectPath: "user.id", operations: { lookup: { label: "Look up item", path: "/api/items/{item}" } }, program: DEFAULT_RELAY_PROGRAM, revision: 1 };
test("relay origins and page paths have exact, canonical boundaries", () => {
  assert.equal(exactRelayOrigin("https://warehouse.test"), "https://warehouse.test");
  for (const value of ["https://warehouse.test/", "https://*.test", "https://user:pass@warehouse.test", "https://warehouse.test/path", "http://warehouse.test"]) assert.throws(() => exactRelayOrigin(value));
  for (const value of ["//other.test", "/ops/../private", "/ops%2fprivate", "/ops/%2e%2e/private", "/ops?token=secret", "/ops#state", "/ops\\private"]) assert.throws(() => exactRelayPath(value));
  assert.equal(exactRelayPath("/ops/", true), "/ops");
});
test("site selection rejects ambiguous, disabled and prefix-confusable rules", () => {
  assert.equal(resolveRelayDefinition([sampleRelay], "https://warehouse.test", "/ops/orders").id, "warehouse");
  for (const [origin, path] of [["https://warehouse.test.evil.test", "/ops"], ["https://warehouse.test", "/ops-other"]]) assert.throws(() => resolveRelayDefinition([sampleRelay], origin, path));
  assert.throws(() => resolveRelayDefinition([{ ...sampleRelay, enabled: false }], "https://warehouse.test", "/ops"));
  assert.throws(() => resolveRelayDefinition([sampleRelay, { ...sampleRelay, id: "other" }], "https://warehouse.test", "/ops"));
  assert.equal(relayDefinitionsOverlap(sampleRelay, { ...sampleRelay, pathPrefix: "/ops/orders" }), true);
  assert.equal(relayDefinitionsOverlap(sampleRelay, { ...sampleRelay, pathPrefix: "/operations" }), false);
});
test("admin definitions compile source without executing it and validate named requests", () => {
  const { revision, ...fields } = sampleRelay;
  assert.equal(revision, 1);
  assert.equal(validateRelayFields({ ...fields, program: 'throw new Error("must not execute on server"); function startTemcoSiteRelay(config) { startDmpRelay(config); }' }).id, "warehouse");
  assert.throws(() => validateRelayFields({ ...fields, program: "function startTemcoSiteRelay( {" }));
  assert.throws(() => validateRelayFields({ ...fields, operations: { bad: { label: "Bad", path: "//attacker.test" } } }));
  assert.throws(() => validateRelayFields({ ...fields, operations: { bad: { label: "Bad", path: "/data", headers: { Authorization: "secret" } } } }));
  assert.equal(buildRelayRequest(sampleRelay.operations, "lookup", { item: "one/two" }).path, "/api/items/one%2Ftwo");
  assert.throws(() => buildRelayRequest(sampleRelay.operations, "__proto__", {}), /Unknown/);
});
test("single bookmark sends only site origin/path and prevents replacement of busy work", () => {
  const script = connectTemcoBookmarklet("https://temco.test");
  assert.match(script, /location.origin/); assert.match(script, /location.pathname/); assert.match(script, /no-referrer/); assert.match(script, /busy/);
  assert.doesNotMatch(script, /location.href|location.search|location.hash|document.cookie|localStorage/);
});
