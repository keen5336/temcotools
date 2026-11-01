import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AdminFileError, listAdminDirectory, normalizeRelativePath, readAdminFileBytes, secureAdminPath } from "../lib/admin-files";
import type { Principal } from "../lib/auth/principal";
import { DEFAULT_TEMPLATE_NAME } from "../app/tools/rtv-label/marsLabelShared";

async function scratch() {
  assert.ok(process.env.TMPDIR?.startsWith("/Volumes/MacDev/"), "Run through dev-run so file fixtures stay on MacDev.");
  return fs.mkdtemp(path.join(process.env.TMPDIR!, "temco-admin-resources-"));
}
test("managed paths reject traversal and cannot read through symbolic or external hard links", async () => {
  for (const value of ["../outside", "inside/../outside", "/absolute", "C:\\outside", "inside\0file", ".temco-upload-private"]) assert.throws(() => normalizeRelativePath(value), AdminFileError);
  assert.equal(normalizeRelativePath("./folder/file.csv"), "folder/file.csv");
  const base = await scratch(), root = path.join(base, "managed");
  try {
    await fs.mkdir(root); await fs.writeFile(path.join(base, "outside.txt"), "SYNTHETIC OUTSIDE DATA"); await fs.writeFile(path.join(root, "inside.txt"), "SYNTHETIC INSIDE DATA");
    await fs.symlink(path.join(base, "outside.txt"), path.join(root, "outside-link.txt"));
    await fs.symlink(base, path.join(root, "outside-folder"));
    await fs.link(path.join(base, "outside.txt"), path.join(root, "outside-hard-link.txt"));
    for (const value of ["outside-link.txt", "outside-hard-link.txt", "outside-folder/outside.txt"]) await assert.rejects(readAdminFileBytes(value, root));
    await assert.rejects(secureAdminPath("outside-folder/new.txt", root, true));
    assert.equal((await readAdminFileBytes("inside.txt", root)).bytes.toString(), "SYNTHETIC INSIDE DATA");
    const entries = await listAdminDirectory("", root);
    assert.equal(entries.filter(entry => entry.kind === "blocked").length, 3);
    assert.equal(await fs.readFile(path.join(base, "outside.txt"), "utf8"), "SYNTHETIC OUTSIDE DATA");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("shared configuration and file actions enforce current authority, defaults, explicit replacement and durable receipts", { skip: !process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Dedicated local test database required.");
  const [{ prisma }, configuration, { createAdminFileCommands }, { resolvePrincipal, CURRENT_USER_SELECT }] = await Promise.all([import("../lib/db"), import("../lib/label-configuration-service"), import("../lib/admin-file-service"), import("../lib/auth/principal")]);
  const base = await scratch(), root = path.join(base, "managed"), files = createAdminFileCommands(root), suffix = randomUUID();
  const users: string[] = [], bundles: string[] = [], printers: string[] = [], templates: string[] = [];
  const originalTemplates = await prisma.labelTemplate.findMany();
  async function actor(capabilities: string[]) {
    const bundle = await prisma.roleBundle.create({ data: { name: `Resource fixture ${randomUUID()}`, capabilities } }); bundles.push(bundle.id);
    const user = await prisma.user.create({ data: { username: `resource-fixture-${randomUUID()}`, displayName: "Synthetic administrator", role: "admin", pinHash: "not-a-usable-credential", roleBundles: { create: { bundleId: bundle.id } } } }); users.push(user.id);
    const at = new Date(), session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, lastActivityAt: at, lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 60 * 60_000), deviceLabel: "Synthetic resource fixture" } });
    const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    assert.ok(principal); return { ...principal, sessionId: session.id } as Principal;
  }
  try {
    const admin = await actor(["labels.manage", "labels.read", "files.manage"]), restricted = await actor(["labels.read"]);
    await assert.rejects(configuration.createPrinter(restricted, { name: `Unauthorized ${suffix}`, endpoint: "http://printer.invalid", contentType: "text/plain" }));
    await assert.rejects(configuration.createPrinter(admin, { name: `Credential endpoint ${suffix}`, endpoint: "http://secret:secret@printer.invalid", contentType: "text/plain" }));
    const printer = await configuration.createPrinter(admin, { name: `Synthetic printer ${suffix}`, endpoint: "http://printer.invalid:9100", contentType: "text/plain" }); printers.push(printer.id);
    assert.equal(printer.createdByUserId, admin.userId);
    await prisma.labelPrinter.update({ where: { id: printer.id }, data: { updatedAt: new Date(printer.updatedAt.getTime() + 1000) } });
    await assert.rejects(configuration.updatePrinter(admin, { id: printer.id, name: printer.name, contentType: printer.contentType, endpoint: "http://changed.invalid", expectedUpdatedAt: printer.updatedAt.toISOString() }), (error: unknown) => error instanceof Error && error.message.includes("changed"));
    assert.equal((await configuration.setPrinterEnabled(admin, { id: printer.id, enabled: false })).isActive, false);
    await configuration.setPrinterEnabled(admin, { id: printer.id, enabled: true });
    for (let index = 0; index < 2; index++) { const template = await configuration.createTemplate(admin, { name: `Synthetic template ${suffix}-${index}`, kind: "pick_wave", zpl: "^XA^FD{{lpn}}^FS^XZ" }); templates.push(template.id); }
    await Promise.all(templates.map(id => configuration.setDefaultTemplate(admin, { id })));
    const currentDefault = await prisma.labelTemplate.findMany({ where: { kind: "pick_wave", isActive: true, isDefault: true } }); assert.equal(currentDefault.length, 1);
    await configuration.setTemplateEnabled(admin, { id: currentDefault[0].id, enabled: false });
    assert.equal((await prisma.labelTemplate.findUniqueOrThrow({ where: { id: currentDefault[0].id } })).isDefault, false);
    await assert.rejects(configuration.setDefaultTemplate(admin, { id: currentDefault[0].id }));
    const settings = await configuration.getManagedLabelConfiguration(admin); assert.ok(settings.printers.some(item => item.id === printer.id));
    assert.ok((await configuration.getOperatorLabelConfiguration(restricted, { kind: "pick_wave" })).templates.every(item => item.id !== currentDefault[0].id));
    await prisma.userSession.update({ where: { id: admin.sessionId }, data: { mfaVerifiedAt: null } });
    await assert.rejects(configuration.setPrinterEnabled(admin, { id: printer.id, enabled: false }));
    await prisma.userSession.update({ where: { id: admin.sessionId }, data: { mfaVerifiedAt: new Date() } });
    await assert.rejects(files.listAdminFiles(restricted));
    const mkdir = { operationId: randomUUID(), path: "", folderName: "incoming" };
    assert.equal((await files.createAdminDirectory(admin, mkdir)).status, "completed");
    assert.deepEqual(await files.createAdminDirectory(admin, mkdir), await files.createAdminDirectory(admin, mkdir));
    await assert.rejects(files.createAdminDirectory(admin, { ...mkdir, folderName: "different" }));
    const upload = { operationId: randomUUID(), path: "incoming", files: [{ name: "demo.txt", contentBase64: Buffer.from("SYNTHETIC CONTENT ONE").toString("base64") }] };
    assert.equal((await files.uploadAdminFiles(admin, upload)).status, "completed");
    assert.equal((await files.uploadAdminFiles(admin, upload)).status, "completed");
    assert.equal(Buffer.from((await files.downloadAdminFile(admin, { path: "incoming/demo.txt" })).contentBase64, "base64").toString(), "SYNTHETIC CONTENT ONE");
    const first = (await files.listAdminFiles(admin, { path: "incoming" })).entries[0];
    assert.equal((await files.uploadAdminFiles(admin, { ...upload, operationId: randomUUID() })).status, "not_applied");
    assert.equal((await files.uploadAdminFiles(admin, { ...upload, operationId: randomUUID(), files: [{ ...upload.files[0], contentBase64: Buffer.from("SYNTHETIC CONTENT TWO").toString("base64"), replace: true, expectedFingerprint: first.fingerprint }] })).status, "completed");
    assert.equal((await files.deleteAdminFile(admin, { operationId: randomUUID(), path: first.path, expectedFingerprint: first.fingerprint })).status, "not_applied");
    const updated = (await files.listAdminFiles(admin, { path: "incoming" })).entries[0];
    assert.equal((await files.moveAdminFile(admin, { operationId: randomUUID(), path: updated.path, destinationPath: "moved.txt", expectedFingerprint: updated.fingerprint })).status, "completed");
    assert.equal(Buffer.from((await files.downloadAdminFile(admin, { path: "moved.txt" })).contentBase64, "base64").toString(), "SYNTHETIC CONTENT TWO");
    const moved = (await files.listAdminFiles(admin)).entries.find(entry => entry.path === "moved.txt")!;
    assert.equal((await files.deleteAdminFile(admin, { operationId: randomUUID(), path: moved.path, expectedFingerprint: moved.fingerprint })).status, "completed");
    if (process.getuid?.() !== 0) {
      await fs.chmod(path.join(root, "incoming"), 0o500);
      const denied = { ...upload, operationId: randomUUID(), files: [{ name: "uncertain.txt", contentBase64: Buffer.from("SYNTHETIC NEVER REPLAY").toString("base64") }] };
      assert.equal((await files.uploadAdminFiles(admin, denied)).status, "unknown");
      await fs.chmod(path.join(root, "incoming"), 0o700);
      assert.equal((await files.uploadAdminFiles(admin, denied)).status, "unknown");
      await assert.rejects(fs.stat(path.join(root, "incoming/uncertain.txt")), { code: "ENOENT" });
    }
    const events = await prisma.identityAudit.findMany({ where: { actorUserId: admin.userId } });
    assert.ok(events.some(event => event.action === "labels.configuration.printer_created"));
    assert.ok(events.some(event => event.action === "files.operation_completed"));
    assert.ok(events.every(event => !event.reason?.includes("SYNTHETIC CONTENT")), "File contents must not enter metadata audit records.");
    await prisma.userSession.update({ where: { id: admin.sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(files.createAdminDirectory(admin, { operationId: randomUUID(), path: "", folderName: "revoked-must-not-create" }));
    await assert.rejects(fs.stat(path.join(root, "revoked-must-not-create")), { code: "ENOENT" });
  } finally {
    await fs.chmod(path.join(root, "incoming"), 0o700).catch(() => undefined); await fs.rm(base, { recursive: true, force: true });
    await prisma.labelPrinter.deleteMany({ where: { id: { in: printers } } });
    await prisma.labelTemplate.deleteMany({ where: { OR: [{ id: { in: templates } }, { id: { notIn: originalTemplates.map(item => item.id) }, name: { in: ["Default Pick Wave 4x3", DEFAULT_TEMPLATE_NAME] } }] } });
    for (const item of originalTemplates) await prisma.labelTemplate.update({ where: { id: item.id }, data: { isDefault: item.isDefault, updatedAt: item.updatedAt, updatedByUserId: item.updatedByUserId } });
    await prisma.identityAudit.deleteMany({ where: { actorUserId: { in: users } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.roleBundle.deleteMany({ where: { id: { in: bundles } } }); await prisma.$disconnect();
  }
});
