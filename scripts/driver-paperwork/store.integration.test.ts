import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_TEMPLATES, templateSchema } from "../../lib/driver-paperwork/templates";
import { getDefaultProgram } from "../../lib/driver-paperwork/program";

const database = process.env.PAPERWORK_TEST_DATABASE_URL;
test("template persistence, live roles, concurrency, idempotent saves and version restore in PostgreSQL", { skip: !database }, async () => {
  // Never run this fixture reset against an inherited application DATABASE_URL.
  const target = new URL(database!);
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/paperwork_qa"); assert.equal(target.port, "55473");
  process.env.DATABASE_URL = database;
  const { prisma } = await import("../../lib/db");
  const { getPublishedTemplate, getTemplateEditor, saveTemplate } = await import("../../lib/driver-paperwork/store");
  const manager = "paperwork-qa-manager", user = "paperwork-qa-user", admin = "paperwork-qa-admin", inactive = "paperwork-qa-inactive";
  const template = templateSchema.parse(DEFAULT_TEMPLATES), program = getDefaultProgram();
  const input = (expectedVersion: number, operationId = randomUUID()) => ({ expectedVersion, operationId, template, program });
  try {
    await prisma.driverPaperworkRevision.deleteMany();
    for (const [id, role, active] of [[manager, "manager", true], [user, "user", true], [admin, "admin", true], [inactive, "manager", false]] as const) {
      await prisma.user.upsert({ where: { id }, create: { id, username: id, displayName: id, role, isActive: active, pinHash: "synthetic-unused" }, update: { role, isActive: active } });
    }
    assert.equal((await getPublishedTemplate()).version, 0);
    assert.equal(await prisma.driverPaperworkRevision.count(), 0, "reading defaults performs no write");
    for (const actor of [user, inactive, "missing-user"]) {
      await assert.rejects(getTemplateEditor(actor), /Manager access|active account/);
      await assert.rejects(saveTemplate(actor, input(0)), /Manager access|active account/);
    }
    const firstInput = input(0); const first = await saveTemplate(manager, firstInput);
    assert.equal(first.version, 1); assert.equal((await getPublishedTemplate()).program, program);
    assert.equal((await saveTemplate(manager, firstInput)).version, 1);
    assert.equal(await prisma.driverPaperworkRevision.count(), 1, "confirmed retry does not create a second revision");
    await assert.rejects(saveTemplate(admin, firstInput), /different edit/);
    await assert.rejects(saveTemplate(manager, { ...firstInput, program: program + "\n// different" }), /different edit/);
    const concurrent = await Promise.allSettled([saveTemplate(manager, input(1)), saveTemplate(admin, input(1))]);
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected" && /newer template/.test(result.reason.message)).length, 1);
    assert.equal(await prisma.driverPaperworkRevision.count(), 2);
    await assert.rejects(saveTemplate(manager, input(0)), /newer template/);
    await assert.rejects(saveTemplate(manager, { ...input(2), program: "function createDriverPaperworkRuntime( {" }), /must compile/);
    const old = (await getTemplateEditor(manager, { version: 1 })).selected!;
    const restored = await saveTemplate(manager, { ...input(2), template: old.template, program: old.program });
    assert.equal(restored.version, 3);
    assert.equal((await getTemplateEditor(manager, { version: 1 })).selected!.version, 1);
    assert.equal((await getTemplateEditor(manager, { operationId: restored.operationId! })).selected!.version, 3);
    assert.deepEqual((await getTemplateEditor(manager)).history.map(item => item.version), [3, 2, 1]);
    await prisma.user.update({ where: { id: manager }, data: { role: "user" } });
    await assert.rejects(saveTemplate(manager, input(3)), /Manager access/);
    await assert.rejects(getTemplateEditor(manager), /Manager access/);
    await prisma.user.update({ where: { id: manager }, data: { role: "manager" } });
    assert.equal((await getPublishedTemplate()).version, 3);
  } finally { await prisma.$disconnect(); }
});
