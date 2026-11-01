import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateRequest } from "./api-relay/protocol.mjs";

export const PILOT_POSTGRES_IMAGE = "postgres@sha256:1d1095b0503145be79c79239372aefadfacf6b7c33c9245bbf99ce4b6b89c737";
export const PILOT_PORTS = { app: 43100, "api-relay": 43103, "mcp-http": 43104 } as const;
const KEYS = ["SLUG", "DATABASE_NAME", "SOURCE_HEAD", "PUBLIC_ORIGIN", "APP_IMAGE", "APP_IMAGE_ID", "MIGRATE_IMAGE", "MIGRATE_IMAGE_ID", "MCP_IMAGE", "MCP_IMAGE_ID", "POSTGRES_IMAGE_ID", "POSTGRES_PASSWORD", "SESSION_SECRET", "MFA_ENCRYPTION_KEY", "DMP_ORIGINS", "DMP_IDENTITY_PATH", "DMP_IDENTITY_SUBJECT_PATH", "DMP_API_OPERATIONS"].map(key => `PILOT_${key}`);
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}$/;
type Dict = Record<string, unknown>;
export class PilotGuardError extends Error {}
function requireGuard(condition: unknown, message: string): asserts condition { if (!condition) throw new PilotGuardError(message); }
function record(value: unknown, message = "Malformed resolved composition."): Dict { requireGuard(value && typeof value === "object" && !Array.isArray(value), message); return value as Dict; }
function sameKeys(value: Dict, keys: string[]) { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function httpsOrigin(raw: string, name: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PilotGuardError(`${name} requires an exact HTTPS origin.`); }
  requireGuard(url.protocol === "https:" && url.origin === raw && !url.username && !url.password && !url.search && !url.hash, `${name} requires an exact HTTPS origin without credentials, path or trailing slash.`);
  return url;
}

export function parsePilotEnvironment(text: string): Record<string, string> {
  requireGuard(Buffer.byteLength(text) <= 64 * 1024, "Pilot environment file is too large.");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(PILOT_[A-Z_]+)=(.*)$/.exec(line);
    requireGuard(match && KEYS.includes(match[1]), "Only documented literal PILOT_ keys are accepted; no production/Compose override variables.");
    const [, key, value] = match;
    requireGuard(!Object.hasOwn(env, key), "Duplicate pilot environment key.");
    requireGuard(value && value === value.trim() && !/[$`\r\n]/.test(value) && !/^["']/.test(value), "Pilot values must be nonempty literals without shell interpolation or surrounding quotes.");
    env[key] = value;
  }
  requireGuard(KEYS.every(key => Object.hasOwn(env, key)), "Fill every documented pilot environment key; no production defaults are inferred.");
  return env;
}

export function validatePilotEnvironment(env: Record<string, string>, expectedHead: string) {
  requireGuard(HEAD.test(expectedHead) && env.PILOT_SOURCE_HEAD === expectedHead, "Pilot source must match the explicit full 40-character source revision.");
  const slug = env.PILOT_SLUG;
  requireGuard(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 24, "Pilot slug must be 1–24 lowercase letters/digits with internal hyphens.");
  const project = `temcotools-v2-pilot-${slug}`;
  const database = `temcotools_v2_pilot_${slug.replaceAll("-", "_")}`;
  requireGuard(env.PILOT_DATABASE_NAME === database, "Pilot database name must use its dedicated prefix and slug (hyphens become underscores).");
  const origin = httpsOrigin(env.PILOT_PUBLIC_ORIGIN, "PILOT_PUBLIC_ORIGIN");
  requireGuard(origin.hostname !== "temco.chronchive.com" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), "Pilot origin must be distinct from the known production origin and loopback.");
  for (const part of ["APP", "MIGRATE", "MCP"]) {
    requireGuard(env[`PILOT_${part}_IMAGE`] === `${project}-${part.toLowerCase()}:${expectedHead}`, "Application images require pilot-specific names and the exact source revision tag; production/mutable tags are refused.");
    requireGuard(IMAGE_ID.test(env[`PILOT_${part}_IMAGE_ID`]), "Each pilot image requires its full local sha256 image ID.");
  }
  requireGuard(IMAGE_ID.test(env.PILOT_POSTGRES_IMAGE_ID), "The pinned PostgreSQL image requires its full local image ID.");
  const secrets = [env.PILOT_POSTGRES_PASSWORD, env.PILOT_SESSION_SECRET, env.PILOT_MFA_ENCRYPTION_KEY];
  requireGuard(secrets.every(value => /^[a-zA-Z0-9_-]{32,128}$/.test(value) && !value.includes("REPLACE")) && new Set(secrets).size === secrets.length, "Supply three separate private URL-safe pilot secrets; placeholders and reused values are refused.");
  requireGuard(Buffer.from(env.PILOT_MFA_ENCRYPTION_KEY, "base64url").length === 32 && Buffer.from(env.PILOT_MFA_ENCRYPTION_KEY, "base64url").toString("base64url") === env.PILOT_MFA_ENCRYPTION_KEY, "Pilot MFA key must encode exactly 32 bytes as canonical base64url.");
  const origins = env.PILOT_DMP_ORIGINS.split(",");
  requireGuard(origins.length > 0 && origins.length <= 8 && new Set(origins).size === origins.length, "Use a bounded exact DMP origin allowlist.");
  for (const value of origins) httpsOrigin(value, "PILOT_DMP_ORIGINS");
  try {
    validateRequest({ path: env.PILOT_DMP_IDENTITY_PATH, timeoutMs: 10000 });
    requireGuard(/^[a-zA-Z0-9_.-]{1,200}$/.test(env.PILOT_DMP_IDENTITY_SUBJECT_PATH), "Invalid DMP subject path.");
    const operations = record(JSON.parse(env.PILOT_DMP_API_OPERATIONS));
    requireGuard(Object.keys(operations).length <= 64, "Too many pilot operations.");
    for (const [name, entry] of Object.entries(operations)) {
      const op = record(entry);
      requireGuard(/^[a-z][a-z0-9_-]{0,63}$/.test(name) && name !== "session" && typeof op.label === "string" && op.label.length > 0 && op.label.length <= 100, "Invalid named pilot operation.");
      requireGuard((op.method ?? "GET") === "GET" && op.body === undefined, "Pilot DMP operations must be GET-only without request bodies.");
      validateRequest({ method: "GET", path: op.path, headers: op.headers ?? {}, timeoutMs: op.timeoutMs ?? 30000 });
    }
  } catch { throw new PilotGuardError("Pilot DMP configuration must use validated relative identity/GET-only named operations; no raw config is emitted."); }
  return { project, slug, sourceHead: expectedHead, publicOrigin: origin.origin, database, cookieName: `temco_v2_pilot_${slug}`, relayAudience: `pilot:${slug}` };
}
export type PilotIdentity = ReturnType<typeof validatePilotEnvironment>;

// Validate the resolved result, not just YAML text or a project-name argument.
export function validatePilotComposition(input: unknown, env: Record<string, string>, expectedHead: string) {
  const identity = validatePilotEnvironment(env, expectedHead);
  const config = record(input), services = record(config.services), networks = record(config.networks), volumes = record(config.volumes);
  requireGuard(config.name === identity.project && sameKeys(services, ["db", "storage-init", "app", "api-relay", "mcp-http", "migrate"]), "Resolved pilot project/service inventory changed; label relays and extra services are refused.");
  requireGuard(sameKeys(networks, ["pilot_net"]) && sameKeys(volumes, ["db_data", "admin_files"]), "Pilot must use only its two private named volumes and private network.");
  const net = record(networks.pilot_net);
  requireGuard(net.name === `${identity.project}-private` && net.driver === "bridge" && net.internal === true && !net.external && !net.driver_opts, "Pilot network must be internal, dedicated and non-external without host bridge overrides.");
  for (const [key, suffix] of [["db_data", "db"], ["admin_files", "admin-files"]]) {
    const volume = record(volumes[key]);
    requireGuard(volume.name === `${identity.project}-${suffix}` && !volume.external && !volume.driver_opts && (!volume.driver || volume.driver === "local"), "Production/external/bind-backed volumes are refused.");
    requireGuard(record(volume.labels)["com.temcotools.pilot.project"] === identity.project, "Pilot volume ownership label is required.");
  }
  requireGuard(record(net.labels)["com.temcotools.pilot.project"] === identity.project, "Pilot network ownership label is required.");
  const databaseUrl = `postgresql://temco_pilot:${env.PILOT_POSTGRES_PASSWORD}@db:5432/${identity.database}`;
  const expectedImages: Record<string, string> = { db: PILOT_POSTGRES_IMAGE, "storage-init": env.PILOT_APP_IMAGE, app: env.PILOT_APP_IMAGE, "api-relay": env.PILOT_APP_IMAGE, "mcp-http": env.PILOT_MCP_IMAGE, migrate: env.PILOT_MIGRATE_IMAGE };
  const allowedMounts: Record<string, string[]> = { db: ["db_data:/var/lib/postgresql/data"], "storage-init": ["admin_files:/data/admin-files"], app: ["admin_files:/data/admin-files"], "api-relay": [], "mcp-http": ["admin_files:/data/admin-files"], migrate: [] };
  for (const [name, entry] of Object.entries(services)) {
    const service = record(entry);
    requireGuard(service.image === expectedImages[name] && service.pull_policy === "never" && service.restart === "no", "Pilot services must use the reviewed local image without implicit pull/build or automatic restart.");
    for (const key of ["build", "container_name", "extends", "env_file", "privileged", "pid", "ipc", "devices", "external_links", "volumes_from", "secrets", "configs", "extra_hosts", "post_start", "pre_stop"]) requireGuard(service[key] === undefined, "Unsupported service override could escape pilot isolation.");
    requireGuard(service.entrypoint == null, "Pilot image entrypoints must not be overridden.");
    if (name !== "storage-init") requireGuard(service.user === undefined, "Pilot program/database image users must not be overridden.");
    if (["app", "db", "migrate"].includes(name)) requireGuard(service.command == null, "Default application/database/migration commands must not be overridden.");
    if (name === "api-relay") requireGuard(JSON.stringify(service.command) === JSON.stringify(["node", "scripts/api-relay/server.mjs"]), "Only the DMP API relay command is allowed.");
    if (name === "mcp-http") requireGuard(JSON.stringify(service.command) === JSON.stringify(["node", "--import", "tsx", "scripts/mcp-http-server.ts"]), "Only the authenticated MCP HTTP command is allowed.");
    const mounts = (service.volumes ?? []) as unknown[];
    requireGuard(Array.isArray(mounts), "Malformed service mounts.");
    const actualMounts = mounts.map(value => { const mount = record(value); requireGuard(mount.type === "volume" && !mount.bind && !mount.subpath, "Only pilot named-volume mounts are allowed."); return `${mount.source}:${mount.target}`; });
    requireGuard(actualMounts.sort().join("\0") === [...allowedMounts[name]].sort().join("\0"), "Unexpected source or target volume; production relative binds are refused.");
    const ports = (service.ports ?? []) as unknown[];
    requireGuard(Array.isArray(ports), "Malformed service ports.");
    const published = PILOT_PORTS[name as keyof typeof PILOT_PORTS];
    requireGuard(ports.length === (published ? 1 : 0), "Database/maintenance ports must remain unpublished.");
    if (published) {
      const port = record(ports[0]);
      const target = name === "app" ? 3000 : name === "api-relay" ? 3003 : 3004;
      requireGuard(port.host_ip === "127.0.0.1" && String(port.published) === String(published) && port.target === target && port.protocol === "tcp", "Pilot ports must use the exact dedicated loopback bindings.");
    }
    if (name === "storage-init") requireGuard(service.network_mode === "none" && service.networks === undefined && service.user === "0:0", "Storage initialization must have no network.");
    else requireGuard(service.network_mode === undefined && sameKeys(record(service.networks), ["pilot_net"]), "A pilot service cannot join another or host network.");
    const vars = name === "storage-init" ? {} : record(service.environment);
    if (["app", "api-relay", "mcp-http"].includes(name)) {
      for (const [key, value] of Object.entries({ TEMCO_PILOT_MODE: "read_only_dmp", TEMCO_SESSION_COOKIE_NAME: identity.cookieName, API_RELAY_AUDIENCE: identity.relayAudience, SESSION_SECRET: env.PILOT_SESSION_SECRET, DMP_ORIGINS: env.PILOT_DMP_ORIGINS })) requireGuard(vars[key] === value, "Pilot identity/mode/secret/relay isolation environment differs.");
    }
    if (["app", "mcp-http", "migrate"].includes(name)) requireGuard(vars.DATABASE_URL === databaseUrl, "Pilot database URL must reference only the dedicated internal database.");
    if (["app", "mcp-http"].includes(name)) {
      for (const [key, value] of Object.entries({ NEXT_PUBLIC_APP_URL: identity.publicOrigin, MCP_ISSUER_URL: `${identity.publicOrigin}/`, MCP_RESOURCE_URL: `${identity.publicOrigin}/mcp`, API_RELAY_PUBLIC_ORIGIN: identity.publicOrigin, API_RELAY_INTERNAL_URL: "http://api-relay:3003", MFA_ENCRYPTION_KEY: env.PILOT_MFA_ENCRYPTION_KEY, ADMIN_FILE_MANAGER_ROOT: "/data/admin-files", DMP_API_OPERATIONS: env.PILOT_DMP_API_OPERATIONS, DMP_IDENTITY_PATH: env.PILOT_DMP_IDENTITY_PATH, DMP_IDENTITY_SUBJECT_PATH: env.PILOT_DMP_IDENTITY_SUBJECT_PATH })) requireGuard(vars[key] === value, "Pilot public origin, OAuth resource, relay, file root or DMP configuration differs.");
    }
    if (name === "api-relay") requireGuard(vars.API_RELAY_APP_URL === "http://app:3000" && vars.API_RELAY_APP_ORIGIN === identity.publicOrigin, "Relay callback must remain within the pilot.");
    if (name === "db") requireGuard(vars.POSTGRES_USER === "temco_pilot" && vars.POSTGRES_DB === identity.database && vars.POSTGRES_PASSWORD === env.PILOT_POSTGRES_PASSWORD, "Database bootstrap credentials/name differ from the pilot target.");
  }
  return identity;
}

export function pilotImageExpectations(env: Record<string, string>, head: string) {
  return ["APP", "MIGRATE", "MCP"].map(part => ({ role: part.toLowerCase(), reference: env[`PILOT_${part}_IMAGE`], id: env[`PILOT_${part}_IMAGE_ID`], revision: head, deploymentRole: "pilot", productionEligible: "false" })).concat([{ role: "postgres", reference: PILOT_POSTGRES_IMAGE, id: env.PILOT_POSTGRES_IMAGE_ID, revision: "", deploymentRole: "", productionEligible: "" }]);
}
export function assertPilotImageMetadata(expected: ReturnType<typeof pilotImageExpectations>[number], lines: string[]) {
  requireGuard(lines[0] === expected.id, "A local pilot image ID changed or is unavailable; no pull/build is attempted.");
  if (expected.role !== "postgres") requireGuard(lines[1] === expected.revision && lines[2] === "pilot" && lines[3] === "false", "Pilot program images must carry the exact OCI source revision and explicit pilot/non-production labels.");
}

function command(program: string, args: string[], env: NodeJS.ProcessEnv): string {
  try { return execFileSync(program, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw new PilotGuardError(`Read-only ${program === "docker" ? "Docker metadata/configuration" : "source"} check failed; raw output is withheld because it may contain private configuration.`); }
}
function safeProcessEnvironment(): NodeJS.ProcessEnv { return { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }; }
function privateFile(filename: string) {
  requireGuard(isAbsolute(filename), "Use an absolute private file path.");
  const stat = lstatSync(filename);
  requireGuard(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (process.getuid?.() === undefined || stat.uid === process.getuid()), "Private input must be an owner-only regular file, not a symlink.");
  return readFileSync(filename, "utf8");
}
function outsideSource(root: string, filename: string) { const rel = relative(root, filename); requireGuard(rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel), "Keep private pilot inputs/artifacts outside the source checkout."); }
function sourceState(root: string, expectedHead: string, env: NodeJS.ProcessEnv) {
  const head = command("git", ["-C", root, "rev-parse", "HEAD"], env).trim();
  const branch = command("git", ["-C", root, "branch", "--show-current"], env).trim();
  requireGuard(head === expectedHead && branch === "v2" && !command("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], env).trim(), "Pilot source must be a clean v2 checkout at the explicitly pinned full revision.");
  return { head, branch, composeSha256: hash(readFileSync(resolve(root, "deploy/v2-pilot.compose.yml"))), guardSha256: hash(readFileSync(resolve(root, "scripts/v2-pilot.ts"))) };
}
function inspectLocalMetadata(context: string, env: NodeJS.ProcessEnv, pilot: PilotIdentity, images: ReturnType<typeof pilotImageExpectations>) {
  requireGuard(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(context), "Name an explicit local Docker context.");
  const endpoint = command("docker", ["context", "inspect", context, "--format", '{{(index .Endpoints "docker").Host}}'], env).trim();
  requireGuard(endpoint.startsWith("unix:///"), "Only an explicitly named local Unix-socket Docker context is allowed; remote hosts are refused.");
  const docker = (...args: string[]) => command("docker", ["--context", context, ...args], env).trim();
  for (const image of images) {
    const format = '{{.Id}}\n{{index .Config.Labels "org.opencontainers.image.revision"}}\n{{index .Config.Labels "com.temcotools.deployment-role"}}\n{{index .Config.Labels "com.temcotools.production-eligible"}}';
    assertPilotImageMetadata(image, docker("image", "inspect", "--format", format, image.reference).split("\n"));
  }
  for (const [kind, resourceNames] of [["volume", [`${pilot.project}-db`, `${pilot.project}-admin-files`]], ["network", [`${pilot.project}-private`]]] as const) {
    const existing = new Set(docker(kind, "ls", "--format", "{{.Name}}").split("\n"));
    for (const name of resourceNames) if (existing.has(name)) {
      const ownership = docker(kind, "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}\n{{index .Labels "com.temcotools.pilot.project"}}', name).split("\n");
      requireGuard(ownership[0] === pilot.project && ownership[1] === pilot.project, "An existing named resource is not owned by this pilot; never adopt/delete it.");
      if (kind === "volume") {
        const driver = docker("volume", "inspect", "--format", "{{.Driver}}\n{{json .Options}}", name).split("\n");
        requireGuard(driver[0] === "local" && ["null", "{}"].includes(driver[1]), "Existing pilot storage must be a plain local named volume without host bind options.");
      } else requireGuard(docker("network", "inspect", "--format", "{{.Driver}} {{.Internal}}", name) === "bridge true", "Existing pilot network must remain an isolated internal bridge.");
    }
  }
  for (const port of Object.values(PILOT_PORTS)) {
    const occupants = docker("container", "ls", "--filter", `publish=${port}`, "--format", '{{.ID}} {{.Label "com.docker.compose.project"}}');
    requireGuard(!occupants || occupants.split("\n").every(line => line.split(" ")[1] === pilot.project), "A dedicated pilot port is published by another Docker project; do not stop or replace it.");
  }
  return { context, imageIdsMatched: true, programLabelsMatched: true, existingResourceOwnershipMatched: true, dockerPublishedPortConflicts: false };
}

export async function runPilotCli() {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: { "env-file": { type: "string" }, "output-dir": { type: "string" }, manifest: { type: "string" }, "expect-source": { type: "string" }, "docker-context": { type: "string" } } });
  const mode = positionals[0];
  requireGuard(positionals.length === 1 && (mode === "render" || mode === "verify"), "Usage: v2-pilot.ts render|verify --env-file /private/pilot.env --expect-source <fullHEAD> [--output-dir /private/new-receipt | --manifest /private/receipt/manifest.json --docker-context <local-context>]. This helper never launches services.");
  requireGuard(values["env-file"] && values["expect-source"], "Explicit private --env-file and --expect-source are required.");
  const root = realpathSync(process.cwd()), envFile = resolve(values["env-file"]);
  outsideSource(root, realpathSync(envFile));
  const pilotEnv = parsePilotEnvironment(privateFile(envFile)), processEnv = safeProcessEnvironment();
  const pilot = validatePilotEnvironment(pilotEnv, values["expect-source"]), source = sourceState(root, pilot.sourceHead, processEnv);
  const resolved = command("docker", ["compose", "--env-file", envFile, "--project-name", pilot.project, "--project-directory", root, "--profile", "*", "-f", resolve(root, "deploy/v2-pilot.compose.yml"), "config", "--format", "json"], { ...processEnv, ...pilotEnv });
  let config: unknown;
  try { config = JSON.parse(resolved); } catch { throw new PilotGuardError("Docker returned invalid resolved configuration; raw output is withheld."); }
  validatePilotComposition(config, pilotEnv, pilot.sourceHead);
  const images = pilotImageExpectations(pilotEnv, pilot.sourceHead);
  const manifest = { version: 1, source, pilot, images, configSha256: hash(canonical(config)), ports: PILOT_PORTS, volumes: [`${pilot.project}-db`, `${pilot.project}-admin-files`], network: `${pilot.project}-private` };
  if (mode === "render") {
    requireGuard(values["output-dir"] && !values.manifest && !values["docker-context"], "Render requires a new --output-dir; local-image verification is a separate explicit verify step.");
    requireGuard(isAbsolute(values["output-dir"]), "Use an absolute new private output directory.");
    const output = resolve(realpathSync(dirname(values["output-dir"])), values["output-dir"].split("/").at(-1)!);
    outsideSource(root, output);
    mkdirSync(output, { mode: 0o700 }); // Existing/symlink outputs are never overwritten.
    writeFileSync(resolve(output, "resolved.compose.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ok: true, qualification: "configuration-only", project: pilot.project, sourceHead: pilot.sourceHead, ports: PILOT_PORTS, requestedPolicy: "read_only_dmp", launchPerformed: false, receiptDirectory: output, next: "Review the private manifest, then verify exact local images/resources. Render is not launch approval or runtime qualification." }));
  } else {
    requireGuard(values.manifest && values["docker-context"] && !values["output-dir"], "Verify requires the reviewed private --manifest and explicit local --docker-context.");
    outsideSource(root, realpathSync(values.manifest));
    let previous: unknown;
    try { previous = JSON.parse(privateFile(values.manifest)); } catch { throw new PilotGuardError("Unreadable private manifest."); }
    requireGuard(canonical(previous) === canonical(manifest), "Source, image pins, isolation settings or private resolved configuration changed since review; render a new receipt.");
    let capturedConfig: unknown;
    try { capturedConfig = JSON.parse(privateFile(resolve(dirname(values.manifest), "resolved.compose.json"))); } catch { throw new PilotGuardError("Unreadable private captured composition."); }
    requireGuard(hash(canonical(capturedConfig)) === manifest.configSha256, "Captured composition no longer matches the reviewed manifest.");
    const inspection = inspectLocalMetadata(values["docker-context"], processEnv, pilot, images);
    console.log(JSON.stringify({ ok: true, qualification: "local-metadata-only", project: pilot.project, sourceHead: pilot.sourceHead, ...inspection, launchPerformed: false, limits: "No host socket probe, health request, secret comparison with production, public route/DNS, bootstrap, migration or service launch was performed. Non-Docker port occupancy and production-metadata/origin comparison remain future launch gates." }));
  }
}
if (process.argv[1]?.endsWith("/v2-pilot.ts")) runPilotCli().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof PilotGuardError ? error.message : "Pilot guard failed; private configuration and raw command output were withheld.", launchPerformed: false })); process.exitCode = 1; });
