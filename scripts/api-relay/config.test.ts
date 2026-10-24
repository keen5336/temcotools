import assert from "node:assert/strict";
import test from "node:test";
import { buildDmpRequest, dmpConfig } from "../../lib/api-relay/config";

test("server owns delivery endpoint and encodes the supplied date/location", () => {
  process.env.DMP_IDENTITY_PATH = "/api/me";
  process.env.DMP_IDENTITY_SUBJECT_PATH = "user.id";
  const request = buildDmpRequest("deliveries", { deliveryDate: "10/24/2026" });
  assert.equal(request.path, "/api/dashboard/v1/driversDeliveries?DeliveryDate=10%2F24%2F2026&LocationNumber=5288");
  assert.equal(request.method, "GET");
  assert.throws(() => buildDmpRequest("__proto__"), /Unknown/);
  assert.throws(() => buildDmpRequest("deliveries", { deliveryDate: { path: "evil" } }), /invalid parameter/);
});

test("new operations and typed request bodies need no bookmarklet change", () => {
  process.env.DMP_API_OPERATIONS = JSON.stringify({ search: { label: "Search", method: "POST", path: "/search?q={query}", headers: { "Content-Type": "application/json" }, body: { count: { $param: "count" } } } });
  try {
    const r = buildDmpRequest("search", { query: "x&other=1", count: 4 });
    assert.equal(r.path, "/search?q=x%26other%3D1"); assert.deepEqual(JSON.parse(r.body!), { count: 4 });
    assert.throws(() => buildDmpRequest("search", { query: "test" }), /count/);
  } finally { delete process.env.DMP_API_OPERATIONS; }
});

test("pairing stays unconfigured without a real DMP identity lookup", () => {
  process.env.DMP_IDENTITY_PATH = ""; process.env.DMP_IDENTITY_SUBJECT_PATH = "";
  try {
    assert.equal(dmpConfig().configured, false);
    assert.throws(() => buildDmpRequest("deliveries", {}), /not configured/);
  } finally { delete process.env.DMP_IDENTITY_PATH; delete process.env.DMP_IDENTITY_SUBJECT_PATH; }
});

test("DMP defaults use the supplied signed-in identity endpoint", () => {
  const config = dmpConfig();
  assert.equal(config.origins[0], "https://dmp.extapps.homedepot.com");
  assert.equal(config.identity!.path, "/identity/me");
  assert.equal(config.subjectPath, "subject");
  assert.equal(config.configured, true);
});
