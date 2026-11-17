import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, stat, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
const run = promisify(execFile), database = process.env.AUTH_TEST_DATABASE_URL;

test("offline operator target/dry-run/file custody and bootstrap boundaries", { skip: !database }, async () => {
  const target = new URL(database!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55476"); assert.equal(target.pathname, "/auth_qa");
  process.env.DATABASE_URL = database; process.env.SESSION_SECRET = "synthetic-auth-test-session-secret-long-enough";
  const { prisma } = await import("../../lib/db");
  const { completeAccountUpdate } = await import("../../lib/auth/identity");
  const scratch = await mkdtemp("/Volumes/MacDev/ProjectArchive/Development/Scratch/auth-operator-");
  const username = "auth-operator-admin";
  const args = ["--username", username, "--expect-host", target.host, "--expect-database", "auth_qa"];
  const invoke = (file: string, options: string[]) => run(process.execPath, ["--import", "tsx", file, ...options], { env: { ...process.env, BOOTSTRAP_ADMIN_USERNAME: username, BOOTSTRAP_ADMIN_DISPLAY_NAME: "Synthetic operator" } });
  try {
    await prisma.user.deleteMany({ where: { username } });
    await prisma.user.create({ data: { username, displayName: "Operator", role: "admin", pinHash: "disabled:enrollment", legacyDisabledAt: new Date() } });
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });
    await invoke("scripts/account-enrollment.ts", args);
    assert.equal(await prisma.accountCode.count({ where: { userId: user.id } }), 0);
    await assert.rejects(invoke("scripts/account-enrollment.ts", [...args, "--expect-host", "wrong.invalid:5432", "--apply"]));
    const delivery = join(scratch, "private-setup.json");
    const apply = [...args, "--apply", "--reason", "verified synthetic operator", "--delivery-file", delivery];
    await chmod(scratch, 0o755); await assert.rejects(invoke("scripts/account-enrollment.ts", apply));
    assert.equal(await prisma.accountCode.count({ where: { userId: user.id } }), 0); await chmod(scratch, 0o700);
    const issued = await invoke("scripts/account-enrollment.ts", apply);
    assert.equal((await stat(delivery)).mode & 0o777, 0o600);
    const payload = JSON.parse(await readFile(delivery, "utf8"));
    assert.ok(payload.code && !issued.stdout.includes(payload.code) && !issued.stderr.includes(payload.code));
    await assert.rejects(invoke("scripts/account-enrollment.ts", apply));
    assert.equal(await prisma.accountCode.count({ where: { userId: user.id } }), 1);
    const row = await completeAccountUpdate({ username, code: payload.code, password: "Synthetic operator cedar 81" }, { source: "qa-operator" });
    assert.equal(row.userId, user.id);
    await invoke("scripts/bootstrap-admin.ts", ["--expect-host", target.host, "--expect-database", "auth_qa", "--apply"]);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).authVersion, 2, "existing enrolled admin unchanged");
    await prisma.user.update({ where: { id: user.id }, data: { role: "user" } });
    await assert.rejects(invoke("scripts/bootstrap-admin.ts", ["--expect-host", target.host, "--expect-database", "auth_qa", "--apply"]));
    await assert.rejects(invoke("scripts/account-enrollment.ts", [...args, "--purpose", "reset", "--apply", "--reason", "synthetic recovery", "--delivery-file", join(scratch, "must-not-create.json")]));
  } finally { await prisma.user.deleteMany({ where: { username } }); await prisma.$disconnect(); await rm(scratch, { recursive: true, force: true }); }
});
