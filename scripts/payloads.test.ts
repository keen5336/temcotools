import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validatePayloadDraft, payloadContentHash, PayloadError, renderPayloadVersion, buildPayloadBookmarklet } from "../lib/payloads/model";
import { payloadPreviewDocument } from "../lib/payloads/types";

const draft = { name: "Synthetic helper", purpose: "dmp_relay", targetOrigins: ["https://dmp.example"], source: 'document.body.dataset.fixture="version-one";', protocolVersion: 1, operationNames: ["session"] };

test("payload source validation compiles without executing and enforces exact origins/contracts", () => {
  const global = globalThis as typeof globalThis & { payloadValidationSideEffect?: boolean };
  delete global.payloadValidationSideEffect;
  const value = validatePayloadDraft({ ...draft, source: "globalThis.payloadValidationSideEffect=true;", targetOrigins: ["https://dmp.example", "https://dmp.example"] });
  assert.equal(global.payloadValidationSideEffect, undefined);
  assert.deepEqual(value.targetOrigins, ["https://dmp.example"]);
  for (const target of ["*", "https://dmp.example/path", "https://dmp.example/", "javascript:alert(1)", "https://*.example"]) {
    assert.throws(() => validatePayloadDraft({ ...draft, targetOrigins: [target] }), PayloadError);
  }
  assert.throws(() => validatePayloadDraft({ ...draft, purpose: "arbitrary-code" }), PayloadError);
  assert.throws(() => validatePayloadDraft({ ...draft, protocolVersion: 2 }), PayloadError);
  assert.throws(() => validatePayloadDraft({ ...draft, operationNames: ["https://other.example"] }), PayloadError);
  assert.throws(() => validatePayloadDraft({ ...draft, source: "function {" }), PayloadError);
});

test("publication fingerprint changes with code and authority but not mutable display name", () => {
  const value = validatePayloadDraft(draft), hash = payloadContentHash(value);
  assert.equal(hash, payloadContentHash({ ...value, name: "Renamed helper" }));
  assert.notEqual(hash, payloadContentHash({ ...value, source: value.source + "\n// changed" }));
  assert.notEqual(hash, payloadContentHash({ ...value, targetOrigins: ["https://another.example"] }));
  assert.notEqual(hash, payloadContentHash({ ...value, operationNames: ["deliveries"] }));
  assert.throws(() => validatePayloadDraft({ ...draft, source: " ".repeat(128 * 1024 + 1) }), PayloadError);
  assert.throws(() => validatePayloadDraft({ ...draft, source: 'const credential="Bearer syntheticcredentialthatislongenough123";' }), PayloadError);
});

test("published script carries pinned metadata and preview cannot break out through a script terminator", () => {
  const value = validatePayloadDraft(draft);
  const source = renderPayloadVersion({ ...value, id: "version-fixture", payloadId: "helper-fixture", version: 3, contentHash: payloadContentHash(value) });
  assert.ok(source.includes('"payloadId":"helper-fixture"'));
  assert.ok(source.includes('"versionId":"version-fixture"'));
  assert.ok(source.includes("Object.freeze("));
  const preview = payloadPreviewDocument('console.log("</script><img src=https://outside.example>");');
  assert.ok(preview.includes("connect-src 'none'"));
  assert.ok(preview.includes("frame-src 'none'"));
  assert.equal((preview.match(/<script>/g) ?? []).length, 2);
  assert.ok(preview.includes("<\\/script>"));
  assert.ok(buildPayloadBookmarklet("https://temco.example/api/payloads/helper-fixture/loader").startsWith("javascript:"));
  assert.throws(() => buildPayloadBookmarklet("javascript:alert(1)"), PayloadError);
});

const databaseUrl = process.env.DATABASE_URL;
test("real payload lifecycle keeps drafts private, versions immutable and concurrent publication safe", { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl!);
  assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Payload test refuses any database except the dedicated local v2 database.");
  const [{ prisma }, service, { resolvePrincipal, CURRENT_USER_SELECT }] = await Promise.all([import("../lib/db"), import("../lib/payloads/service"), import("../lib/auth/principal")]);
  const suffix = randomUUID(), payloadId = `helper-${suffix}`;
  const user = await prisma.user.create({ data: { username: `payload-fixture-${suffix}`, displayName: "Synthetic payload admin", pinHash: "not-a-usable-credential", role: "admin" } });
  const bundle = await prisma.roleBundle.create({ data: { name: `Payload fixture ${suffix}`, capabilities: ["payloads.manage"] } });
  await prisma.userRoleBundle.create({ data: { userId: user.id, bundleId: bundle.id } });
  const at = new Date();
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, lastActivityAt: at, lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 60 * 60_000), deviceLabel: "Synthetic test" } });
  const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
  assert.ok(principal);
  Object.assign(principal, { sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() });
  try {
    await assert.rejects(service.listPayloads({ ...principal, role: "manager" }));
    const created = await service.createPayload(principal, { ...validatePayloadDraft(draft), id: payloadId, note: "Synthetic first draft" });
    assert.deepEqual(await service.resolvePublishedPayload(payloadId), { state: "unpublished" });
    await assert.rejects(service.publishPayload(principal, { id: payloadId, expectedRevision: created.revision, note: "Unreviewed", reviewedNoSecrets: false }));
    const first = await service.publishPayload(principal, { id: payloadId, expectedRevision: created.revision, note: "Synthetic first publish", reviewedNoSecrets: true });
    const privateSource = 'document.body.dataset.fixture="private-draft-two";';
    const edited = await service.savePayloadDraft(principal, { ...validatePayloadDraft({ ...draft, source: privateSource }), id: payloadId, expectedRevision: first.payload.revision, note: "Synthetic second draft" });
    const stillFirst = await service.resolvePublishedPayload(payloadId);
    assert.equal(stillFirst.state, "published");
    if (stillFirst.state === "published") assert.equal(stillFirst.version.source, draft.source);
    assert.equal((await service.getPublishedVersion(payloadId, first.published.id, first.published.contentHash)).source, draft.source);
    const simultaneous = await Promise.allSettled([1, 2].map(index => service.publishPayload(principal, { id: payloadId, expectedRevision: edited.revision, note: `Concurrent publisher ${index}`, reviewedNoSecrets: true })));
    assert.equal(simultaneous.filter(result => result.status === "fulfilled").length, 1);
    const rejected = simultaneous.find(result => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof PayloadError && rejected.reason.status === 409);
    const versions = await prisma.payloadVersion.findMany({ where: { payloadId }, orderBy: { version: "asc" } });
    assert.equal(versions.length, 2);
    assert.equal(versions[0].source, draft.source);
    assert.equal(versions[1].source, privateSource);
    await assert.rejects(prisma.payloadVersion.update({ where: { id: versions[0].id }, data: { source: "changed" } }));
    const beforeRollback = await service.getPayload(principal, payloadId);
    const rolledBack = await service.rollbackPayload(principal, { id: payloadId, expectedRevision: beforeRollback.revision, versionId: first.published.id, note: "Synthetic rollback" });
    assert.equal(rolledBack.publishedVersionId, first.published.id);
    assert.equal((await service.getPublishedVersion(payloadId, versions[1].id, versions[1].contentHash)).source, privateSource);
    const disabled = await service.setPayloadEnabled(principal, { id: payloadId, expectedRevision: rolledBack.revision, enabled: false, note: "Synthetic disable" });
    assert.deepEqual(await service.resolvePublishedPayload(payloadId), { state: "disabled" });
    await assert.rejects(service.getPublishedVersion(payloadId, first.published.id, first.published.contentHash));
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await assert.rejects(service.setPayloadEnabled(principal, { id: payloadId, expectedRevision: disabled.revision, enabled: true, note: "Revoked session cannot enable" }));
    assert.ok((await prisma.payloadAudit.count({ where: { payloadId, actorUserId: user.id } })) >= 6);
  } finally {
    await prisma.payload.updateMany({ where: { id: payloadId }, data: { publishedVersionId: null } });
    await prisma.payloadAudit.deleteMany({ where: { payloadId } });
    await prisma.payloadVersion.deleteMany({ where: { payloadId } });
    await prisma.payload.deleteMany({ where: { id: payloadId } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.roleBundle.deleteMany({ where: { id: bundle.id } });
    await prisma.$disconnect();
  }
});
