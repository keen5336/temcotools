import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";

const testUrl = process.env.WAREHOUSE_TEST_DATABASE_URL;
test("physical-unit notes retain attributed immutable revisions without granting workflow authority", { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!); assert.equal(url.protocol, "postgresql:"); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55439"); assert.equal(url.pathname, "/temcotools_v2_test"); assert.equal(url.search, "");
  process.env.DATABASE_URL = testUrl;
  const { prisma } = await import("../lib/db"); const notes = await import("../lib/warehouse/notes"); const warehouse = await import("../lib/warehouse/units");
  const prefix = `UNIT-NOTES-${randomUUID()}`; const bundle = await prisma.roleBundle.create({ data: { name: prefix, capabilities: [...CAPABILITIES] } });
  const users = []; const sessions: { id: string }[] = []; const actors: Principal[] = [];
  for (let index = 0; index < 2; index++) {
    const user = await prisma.user.create({ data: { username: `${prefix}-${index}`, displayName: `Synthetic note author ${index}`, role: "user", pinHash: "not-a-credential", roleBundles: { create: { bundleId: bundle.id } } } }); users.push(user);
    const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic note test", expiresAt: new Date(Date.now() + 3_600_000) } }); sessions.push(session);
    actors.push({ userId: user.id, username: user.username, displayName: user.displayName, role: user.role, authVersion: user.authVersion, capabilities: [...CAPABILITIES], sessionId: session.id });
  }
  const [author, office] = actors; const operator = { ...office, capabilities: office.capabilities.filter((cap) => cap !== "office.decide") };
  const a = await prisma.warehouseUnit.create({ data: { createdByUserId: author.userId } }); const b = await prisma.warehouseUnit.create({ data: { createdByUserId: author.userId } });
  const operation = () => randomUUID(); let noteId = "";
  try {
    await warehouse.linkWarehouseIdentifier(author, { unitId: a.id, kind: "lpn", value: `${prefix}-LPN`, evidence: "Synthetic LPN label identifies appliance A." }); await warehouse.linkWarehouseIdentifier(author, { unitId: a.id, kind: "msn", value: `${prefix}-MSN`, evidence: "Synthetic reviewed MSN belongs to appliance A." });
    await t.test("one idempotent attributed note is shared by exact linked aliases, never by order context or another unit", async () => {
      const input = { operationId: operation(), unitId: a.id, body: "Synthetic context: confirm cosmetic condition with office. This note is not an RTV authorization." };
      const saved = await Promise.all([notes.appendWarehouseUnitNote(author, input), notes.appendWarehouseUnitNote(author, input)]); assert.deepEqual(saved[0], saved[1]); noteId = saved[0].note.noteId; assert.equal(saved[0].note.authorUserId, author.userId);
      await assert.rejects(notes.appendWarehouseUnitNote(author, { ...input, body: "Synthetic changed body under the same operation ID." }), /already used/);
      const lpn = await warehouse.resolveWarehouseIdentifier(author, { value: `${prefix}-LPN` }); const msn = await warehouse.resolveWarehouseIdentifier(author, { value: `${prefix}-MSN` }); assert.equal(lpn.unitId, msn.unitId);
      assert.equal((await notes.listWarehouseUnitNotes(author, { unitId: lpn.unitId })).notes[0].noteId, noteId); assert.equal((await notes.listWarehouseUnitNotes(author, { unitId: msn.unitId })).notes[0].noteId, noteId); assert.equal((await notes.listWarehouseUnitNotes(author, { unitId: b.id })).notes.length, 0);
      assert.equal(await prisma.officeDisposition.count({ where: { unitId: a.id } }), 0); assert.equal(await prisma.warehousePhysicalObservation.count({ where: { unitId: a.id } }), 0);
    });
    await t.test("authors correct their own text with reason, expected revision and immutable original content", async () => {
      const corrected = await notes.correctWarehouseUnitNote(author, { operationId: operation(), noteId, expectedRevision: 1, action: "correct", body: "Synthetic corrected context: cabinet photo is already recorded elsewhere.", reason: "Synthetic author corrected an earlier wording mistake." }); assert.equal(corrected.note.revision, 2);
      const history = await notes.getWarehouseUnitNote(author, { noteId }); assert.deepEqual(history.revisions.map((revision) => revision.revision), [2, 1]); assert.match(history.revisions[1].body, /not an RTV authorization/); assert.equal(history.revisions[0].editorUsername, author.username);
      await assert.rejects(notes.correctWarehouseUnitNote(author, { operationId: operation(), noteId, expectedRevision: 1, action: "tombstone", reason: "Synthetic stale edit should not overwrite revision two." }), /changed/);
      await assert.rejects(prisma.warehouseUnitNoteRevision.update({ where: { noteId_revision: { noteId, revision: 1 } }, data: { body: "Synthetic direct overwrite must be rejected." } }), /immutable/);
      assert.match((await notes.getWarehouseUnitNote(author, { noteId })).revisions.find((revision) => revision.revision === 1)!.body, /not an RTV authorization/);
    });
    await t.test("another writer needs current office authority; concurrent revisions cannot overwrite each other", async () => {
      const input = { operationId: operation(), noteId, expectedRevision: 2, action: "correct" as const, body: "Synthetic office-reviewed appliance context.", reason: "Synthetic office reconciled a second author's context." };
      await assert.rejects(notes.correctWarehouseUnitNote(operator, input), /permission/i);
      const accepted = await notes.correctWarehouseUnitNote(office, input); assert.equal(accepted.note.revision, 3); assert.equal(accepted.note.authorUserId, author.userId); assert.equal(accepted.note.updatedByUserId, office.userId);
      await assert.rejects(notes.correctWarehouseUnitNote(operator, input), /permission/i, "A receipt replay does not bypass current office permission.");
      const history = await notes.getWarehouseUnitNote(author, { noteId }); assert.equal(history.revisions[0].correctedOtherAuthor, true);
      const results = await Promise.allSettled([notes.correctWarehouseUnitNote(author, { operationId: operation(), noteId, expectedRevision: 3, action: "correct", body: "Synthetic concurrent correction one.", reason: "Synthetic first concurrent correction." }), notes.correctWarehouseUnitNote(office, { operationId: operation(), noteId, expectedRevision: 3, action: "correct", body: "Synthetic concurrent correction two.", reason: "Synthetic second concurrent correction." })]); assert.equal(results.filter((result) => result.status === "fulfilled").length, 1); assert.equal((await notes.getWarehouseUnitNote(author, { noteId })).note.revision, 4);
    });
    await t.test("withdrawal and restoration append attributed history; safe replay returns the original receipt", async () => {
      const input = { operationId: operation(), noteId, expectedRevision: 4, action: "tombstone" as const, reason: "Synthetic outdated context is withdrawn, with its history retained." };
      const withdrawn = await notes.correctWarehouseUnitNote(author, input); assert.equal(withdrawn.note.state, "tombstoned"); assert.equal(withdrawn.note.body, ""); assert.deepEqual(await notes.correctWarehouseUnitNote(author, input), withdrawn);
      assert.equal((await notes.listWarehouseUnitNotes(author, { unitId: a.id, includeTombstoned: false })).notes.length, 0); assert.equal((await notes.listWarehouseUnitNotes(author, { unitId: a.id })).notes.length, 1);
      const restored = await notes.correctWarehouseUnitNote(author, { operationId: operation(), noteId, expectedRevision: 5, action: "restore", body: "Synthetic restored appliance context after further review.", reason: "Synthetic review confirms useful context should be restored." }); assert.equal(restored.note.revision, 6); assert.equal(restored.note.state, "active"); assert.equal((await notes.getWarehouseUnitNote(author, { noteId })).revisions.length, 6);
    });
    await t.test("notes and full revision history paginate without losing old text", async () => {
      for (let index = 0; index < 5; index++) await notes.appendWarehouseUnitNote(author, { operationId: operation(), unitId: a.id, body: `Synthetic additional appliance context ${index}.` });
      const noteIds = new Set<string>(); let afterId: string | undefined;
      do { const page = await notes.listWarehouseUnitNotes(author, { unitId: a.id, limit: 2, afterId }); for (const note of page.notes) { assert.equal(noteIds.has(note.noteId), false); noteIds.add(note.noteId); } afterId = page.nextAfterId ?? undefined; } while (afterId); assert.equal(noteIds.size, 6);
      const revisions = new Set<number>(); let beforeRevision: number | undefined;
      do { const page = await notes.getWarehouseUnitNote(author, { noteId, limit: 2, beforeRevision }); for (const revision of page.revisions) { assert.equal(revisions.has(revision.revision), false); revisions.add(revision.revision); } beforeRevision = page.nextBeforeRevision ?? undefined; } while (beforeRevision); assert.equal(revisions.size, 6);
    });
    await t.test("revocation affects writes and caller-supplied authorship is rejected", async () => {
      await assert.rejects(notes.appendWarehouseUnitNote(author, { operationId: operation(), unitId: a.id, body: "Synthetic invalid impersonation.", authorUserId: office.userId }));
      await prisma.userSession.update({ where: { id: sessions[0].id }, data: { revokedAt: new Date() } }); await assert.rejects(notes.appendWarehouseUnitNote(author, { operationId: operation(), unitId: a.id, body: "Synthetic revoked writer must be denied." }), /session ended/);
    });
  } finally {
    const ownedNotes = await prisma.warehouseUnitNote.findMany({ where: { unitId: { in: [a.id, b.id] } }, select: { id: true } }); await prisma.warehouseUnitNoteRevision.deleteMany({ where: { noteId: { in: ownedNotes.map((note) => note.id) } } }); await prisma.warehouseUnitNote.deleteMany({ where: { unitId: { in: [a.id, b.id] } } });
    await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: [a.id, b.id] } } }); await prisma.warehouseUnit.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.identityAudit.deleteMany({ where: { actorUserId: { in: users.map((user) => user.id) } } }); await prisma.userSession.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } }); await prisma.userRoleBundle.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } }); await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } }); await prisma.roleBundle.delete({ where: { id: bundle.id } }); await prisma.$disconnect();
  }
});
