import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assertPilotImageMetadata, inspectLocalMetadata, parsePilotEnvironment, PILOT_POSTGRES_IMAGE, pilotImageExpectations, validatePilotComposition, validatePilotEnvironment } from "./v2-pilot";

const head = "a".repeat(40);
function environment() {
  const project = "temcotools-v2-pilot-synthetic";
  return {
    PILOT_SLUG: "synthetic", PILOT_DATABASE_NAME: "temcotools_v2_pilot_synthetic", PILOT_SOURCE_HEAD: head, PILOT_PUBLIC_ORIGIN: "https://synthetic-pilot.example.invalid",
    PILOT_APP_IMAGE: `${project}-app:${head}`, PILOT_APP_IMAGE_ID: `sha256:${"1".repeat(64)}`,
    PILOT_MIGRATE_IMAGE: `${project}-migrate:${head}`, PILOT_MIGRATE_IMAGE_ID: `sha256:${"2".repeat(64)}`,
    PILOT_MCP_IMAGE: `${project}-mcp:${head}`, PILOT_MCP_IMAGE_ID: `sha256:${"3".repeat(64)}`,
    PILOT_POSTGRES_IMAGE_ID: `sha256:${"4".repeat(64)}`,
    // Deliberately public synthetic fixture values, never generated/deployed keys.
    PILOT_POSTGRES_PASSWORD: "synthetic_password_".padEnd(64, "p"),
    PILOT_SESSION_SECRET: "synthetic_session_".padEnd(64, "s"),
    PILOT_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    PILOT_DMP_ORIGINS: "https://synthetic-dmp.example.invalid",
    PILOT_DMP_IDENTITY_PATH: "/synthetic/identity", PILOT_DMP_IDENTITY_SUBJECT_PATH: "synthetic.subject",
    PILOT_DMP_API_OPERATIONS: JSON.stringify({ synthetic: { label: "Synthetic GET", path: "/synthetic/units?day={day}", defaults: { day: "synthetic" } } }),
  };
}

test("literal pilot inputs bind source, names, distinct identity and GET-only configuration", () => {
  const env = environment();
  const text = Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
  assert.deepEqual(parsePilotEnvironment(`# synthetic only\n${text}\n`), env);
  assert.equal(validatePilotEnvironment(env, head).relayAudience, "pilot:synthetic");
  assert.equal(validatePilotEnvironment(env, head).cookieName, "temco_v2_pilot_synthetic");
  for (const patch of [
    { PILOT_PUBLIC_ORIGIN: "https://temco.chronchive.com" }, { PILOT_PUBLIC_ORIGIN: "http://synthetic-pilot.example.invalid" },
    { PILOT_PUBLIC_ORIGIN: "https://synthetic-pilot.example.invalid/" }, { PILOT_SLUG: "../production" },
    { PILOT_DATABASE_NAME: "ops_tools" },
    { PILOT_APP_IMAGE: "temcotools-app" }, { PILOT_APP_IMAGE: "temcotools-v2-pilot-synthetic-app:latest" },
    { PILOT_APP_IMAGE_ID: "sha256:short" }, { PILOT_SOURCE_HEAD: "b".repeat(40) },
    { PILOT_SESSION_SECRET: env.PILOT_POSTGRES_PASSWORD }, { PILOT_MFA_ENCRYPTION_KEY: "x".repeat(44) },
    { PILOT_DMP_IDENTITY_PATH: "https://synthetic-dmp.example.invalid/identity" },
    { PILOT_DMP_API_OPERATIONS: JSON.stringify({ synthetic: { label: "Mutation", path: "/synthetic", method: "POST" } }) },
    { PILOT_DMP_API_OPERATIONS: JSON.stringify({ synthetic: { label: "Credentials", path: "/synthetic", headers: { Authorization: "synthetic" } } }) },
  ]) assert.throws(() => validatePilotEnvironment({ ...env, ...patch }, head));
  for (const suffix of ["\nDATABASE_URL=production", "\nCOMPOSE_FILE=docker-compose.yml", "\nPILOT_SLUG=duplicate", "\nPILOT_UNUSED=unknown"]) assert.throws(() => parsePilotEnvironment(text + suffix));
  assert.throws(() => parsePilotEnvironment(text.replace("PILOT_SLUG=synthetic", "PILOT_SLUG=$(synthetic)")));
  assert.throws(() => parsePilotEnvironment(text.replace("PILOT_SLUG=synthetic", 'PILOT_SLUG="synthetic"')));
});

test("actual standalone Compose render isolates all resources and rejects escaping resolved configurations", () => {
  const env = environment(), directory = mkdtempSync(resolve(tmpdir(), "temcotools-v2-pilot-render-"));
  chmodSync(directory, 0o700);
  try {
    const envFile = resolve(directory, "synthetic.env");
    writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    const rendered = execFileSync("docker", ["compose", "--env-file", envFile, "--project-name", "temcotools-v2-pilot-synthetic", "--project-directory", process.cwd(), "--profile", "*", "-f", resolve("deploy/v2-pilot.compose.yml"), "config", "--format", "json"], {
      encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    const config = JSON.parse(rendered);
    const identity = validatePilotComposition(config, env, head);
    assert.equal(identity.database, "temcotools_v2_pilot_synthetic");
    assert.equal(config.services.db.image, PILOT_POSTGRES_IMAGE);
    assert.deepEqual(Object.keys(config.services).sort(), ["api-relay", "app", "db", "mcp-http", "migrate", "storage-init"]);
    assert.equal(config.services.app.environment.MCP_RESOURCE_URL, `${env.PILOT_PUBLIC_ORIGIN}/mcp`);
    assert.equal(config.services["api-relay"].environment.API_RELAY_AUDIENCE, "pilot:synthetic");
    assert.ok(!rendered.includes("temco.chronchive.com") && !rendered.includes("runtime/admin-files") && !rendered.includes("label-relay"));
    const reject = (mutate: (value: typeof config) => void) => { const changed = structuredClone(config); mutate(changed); assert.throws(() => validatePilotComposition(changed, env, head)); };
    reject(c => { c.services.app.container_name = "temcotools"; });
    reject(c => { c.services.app.build = { context: "." }; });
    reject(c => { c.services.app.entrypoint = ["node", "scripts/label-relay/server.mjs"]; });
    reject(c => { c.services.app.command = ["node", "scripts/label-relay/server.mjs"]; });
    reject(c => { c.services["api-relay"].command = ["node", "scripts/label-relay/server.mjs"]; });
    reject(c => { c.services.app.pull_policy = "always"; });
    reject(c => { c.services.app.restart = "unless-stopped"; });
    reject(c => { c.services.app.image = "temcotools-app"; });
    reject(c => { c.services["label-relay"] = c.services["api-relay"]; });
    reject(c => { c.services.app.ports[0].host_ip = "0.0.0.0"; });
    reject(c => { c.services.app.ports[0].published = "3000"; });
    reject(c => { c.services.db.ports = [{ published: "5432", target: 5432, host_ip: "127.0.0.1", protocol: "tcp" }]; });
    reject(c => { c.services.app.volumes[0] = { type: "bind", source: "/srv/temcotools/runtime/admin-files", target: "/data/admin-files" }; });
    reject(c => { c.volumes.db_data.external = true; });
    reject(c => { c.volumes.db_data.name = "temcotools_db_data"; });
    reject(c => { c.volumes.admin_files.driver_opts = { type: "none", device: "/srv/temcotools/runtime", o: "bind" }; });
    reject(c => { c.networks.pilot_net.internal = true; });
    reject(c => { c.services.app.networks = { temco_net: null }; });
    reject(c => { c.services["storage-init"].network_mode = "host"; });
    for (const [key, value] of Object.entries({ DATABASE_URL: "postgresql://synthetic:synthetic@production/ops_tools", NEXT_PUBLIC_APP_URL: "https://temco.chronchive.com", MCP_RESOURCE_URL: "https://temco.chronchive.com/mcp", TEMCO_SESSION_COOKIE_NAME: "temco_session", API_RELAY_AUDIENCE: "production", TEMCO_PILOT_MODE: "off", ADMIN_FILE_MANAGER_ROOT: "/production" })) reject(c => { c.services.app.environment[key] = value; });
    reject(c => { c.services["api-relay"].environment.API_RELAY_APP_URL = "http://temcotools:3000"; });
    reject(c => { c.services.migrate.environment.DATABASE_URL = "postgresql://synthetic:synthetic@production/ops_tools"; });
    // Configuration/fixtures only: no Docker daemon/image lookup or runtime run.
  } finally { rmSync(directory, { recursive: true }); }
});

test("exact local image metadata needs source revision and pilot labels, not a mutable tag", () => {
  const expected = pilotImageExpectations(environment(), head);
  for (const image of expected) {
    const metadata = [image.id, image.revision, image.deploymentRole, image.productionEligible];
    assert.doesNotThrow(() => assertPilotImageMetadata(image, metadata));
    assert.throws(() => assertPilotImageMetadata(image, [`sha256:${"f".repeat(64)}`, ...metadata.slice(1)]));
    if (image.role !== "postgres") for (const [index, bad] of [[1, "b".repeat(40)], [2, "production"], [3, "true"]] as const) {
      const changed = [...metadata]; changed[index] = bad;
      assert.throws(() => assertPilotImageMetadata(image, changed));
    }
  }
});

test("actual explicit synthetic pilot image/resource metadata supports the upstream PostgreSQL image without program labels", { skip: !process.env.PILOT_METADATA_FIXTURE_ENV_FILE }, () => {
  const filename = process.env.PILOT_METADATA_FIXTURE_ENV_FILE!;
  assert.ok(filename.startsWith("/Volumes/MacDev/ProjectArchive/Development/Qualification/") && filename.endsWith("/pilot.env"), "Native metadata qualification requires an explicitly selected task-private synthetic environment.");
  const env = parsePilotEnvironment(readFileSync(filename, "utf8"));
  assert.ok(["synthetic", "synthetic-bridge"].includes(env.PILOT_SLUG));
  assert.equal(env.PILOT_PUBLIC_ORIGIN, "https://app.pilot.localhost:43101");
  const identity = validatePilotEnvironment(env, env.PILOT_SOURCE_HEAD);
  const result = inspectLocalMetadata("desktop-linux", process.env, identity, pilotImageExpectations(env, env.PILOT_SOURCE_HEAD));
  assert.equal(result.imageIdsMatched, true);
  assert.equal(result.programLabelsMatched, true);
  assert.equal(result.existingResourceOwnershipMatched, true);
  assert.equal(result.dockerPublishedPortConflicts, false);
});
