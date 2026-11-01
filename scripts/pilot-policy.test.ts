import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { pilotPolicy, assertPilotReadMethod } from "./pilot-policy.mjs";
import { assertCapability, CAPABILITIES, resolvePrincipal, type Principal } from "../lib/auth/principal";
import { buildDmpRequest, dmpConfig } from "../lib/api-relay/config";
import { listApplicationActions } from "../lib/application/actions";

test("pilot restrictions narrow current principals, MCP discovery and named live methods while normal mode remains compatible", async () => {
  const previous = { mode: process.env.TEMCO_PILOT_MODE, operations: process.env.DMP_API_OPERATIONS };
  const at = Date.now(), claim = { userId: "synthetic-pilot-user", sessionId: "synthetic-pilot-session", authVersion: 1, issuedAt: at, expiresAt: at + 3_600_000 };
  const lookup = async () => ({ id: claim.userId, username: "synthetic-pilot", displayName: "Synthetic pilot", role: "admin" as const, isActive: true, authVersion: 1, roleBundles: [{ bundle: { capabilities: [...CAPABILITIES] } }] });
  try {
    delete process.env.TEMCO_PILOT_MODE;
    process.env.DMP_API_OPERATIONS = JSON.stringify({ synthetic_write: { label: "Synthetic write", method: "POST", path: "/synthetic/write" } });
    const ordinary = await resolvePrincipal(claim, lookup); assert.ok(ordinary); assertCapability(ordinary, "labels.print"); assert.equal(buildDmpRequest("synthetic_write").method, "POST");
    process.env.TEMCO_PILOT_MODE = "read_only_dmp";
    const pilot = await resolvePrincipal(claim, lookup); assert.ok(pilot);
    for (const capability of ["labels.print", "workflow.execute", "office.authorize_rtv"] as const) {
      assert.equal(pilot.capabilities.includes(capability), false);
      assert.throws(() => assertCapability(ordinary, capability), /isolated/);
    }
    assertCapability(pilot, "workflow.read"); assertCapability(pilot, "files.manage");
    const names = listApplicationActions({ ...ordinary, sessionId: claim.sessionId } as Principal).map(action => action.name);
    assert.ok(names.includes("dmp.request")); assert.ok(names.includes("dmp.samples.save"));
    assert.equal(names.includes("labels.prepare"), false); assert.equal(names.includes("mars.unit.stage"), false);
    assert.equal(Object.hasOwn(dmpConfig().operations, "synthetic_write"), false);
    assert.throws(() => buildDmpRequest("synthetic_write"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.throws(() => assertPilotReadMethod(method), /named DMP GET\/HEAD/);
    assert.doesNotThrow(() => assertPilotReadMethod("GET")); assert.doesNotThrow(() => assertPilotReadMethod("HEAD"));
    assert.equal(pilotPolicy().permitsLivePrinting, false); assert.equal(pilotPolicy().permitsLiveMars, false);
    process.env.TEMCO_PILOT_MODE = "typo"; assert.throws(() => pilotPolicy(), /Unsupported/);
  } finally {
    for (const [key, value] of Object.entries({ TEMCO_PILOT_MODE: previous.mode, DMP_API_OPERATIONS: previous.operations })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("pilot session envelope requires an explicit distinct host-only cookie without changing the default production cookie", () => {
  const run = (pilot: boolean, cookie?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", SESSION_SECRET: "synthetic-pilot-session-secret-32-characters", ...(pilot ? { TEMCO_PILOT_MODE: "read_only_dmp" } : {}) };
    if (!pilot) delete env.TEMCO_PILOT_MODE;
    if (cookie) env.TEMCO_SESSION_COOKIE_NAME = cookie; else delete env.TEMCO_SESSION_COOKIE_NAME;
    return spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./lib/session.ts').then(m=>{const s=m.sessionOptions||m.default.sessionOptions;console.log(JSON.stringify({name:s.cookieName,options:s.cookieOptions}))})"], { cwd: process.cwd(), env, encoding: "utf8" });
  };
  const ordinary = run(false); assert.equal(ordinary.status, 0); assert.equal(JSON.parse(ordinary.stdout).name, "temco_session");
  assert.notEqual(run(true).status, 0);
  const pilot = run(true, "temco_v2_pilot_synthetic"); assert.equal(pilot.status, 0);
  const result = JSON.parse(pilot.stdout); assert.equal(result.name, "temco_v2_pilot_synthetic"); assert.equal(result.options.path, "/"); assert.equal(result.options.httpOnly, true); assert.equal(result.options.secure, true); assert.equal(result.options.domain, undefined);
});
