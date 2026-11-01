import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplicationMcpServer } from "../lib/application/mcp";
import { CAPABILITIES, CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import { labelWorkflowSaveInput, saveLabelWorkflow } from "../lib/labels/workflows";
import { payloadDraftSaveInput } from "../lib/payloads/service";
import { adminFileMoveInput, adminFilesListInput } from "../lib/admin-file-service";

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  writeOnly?: boolean;
}
const principal: Principal = { userId: "synthetic-discovery-only", username: "synthetic-discovery", displayName: "Synthetic discovery", role: "admin", authVersion: 1, capabilities: CAPABILITIES };
async function connect(p: Principal) {
  const server = createApplicationMcpServer(async () => p), client = new Client({ name: "synthetic-action-discovery", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.allSettled([client.close(), server.close()]) };
}
function body(result: Record<string, unknown>) { return JSON.parse((result.content as { type: string; text: string }[])[0].text); }
async function describe(client: Client, action: string): Promise<{ name: string; inputSchema: JsonSchema; requiresUserInteraction?: boolean }> {
  const result = await client.callTool({ name: "application_action_info", arguments: { action } });
  assert.notEqual(result.isError, true, `${action} must be discoverable for its authorized principal.`);
  const data = body(result); assert.equal(data.name, action); assert.equal(data.inputSchema?.type, "object");
  return data;
}

test("SDK discovery describes retained, file, payload and label contracts without changing input defaults or device authority", async () => {
  const connection = await connect(principal);
  try {
    const { client } = connection;
    for (const prefix of ["labels.", "printing.", "files.", "payloads.", "scan-lists.", "route-recon."]) {
      const listed = await client.callTool({ name: "application_actions", arguments: { prefix } });
      for (const { name } of body(listed) as { name: string }[]) await describe(client, name);
    }
    const move = (await describe(client, "files.move")).inputSchema;
    assert.deepEqual(move.required?.sort(), ["destinationPath", "expectedFingerprint", "operationId", "path"]);
    assert.equal(move.properties?.path.type, "string", "Input-side schema preserves the resource path before its native transform.");
    assert.equal(move.properties?.operationId.minLength, 16);
    const upload = (await describe(client, "files.list")).inputSchema;
    assert.equal(upload.required?.includes("path") ?? false, false); assert.equal(upload.properties?.path.default, "");
    assert.deepEqual(adminFilesListInput.parse({}), { path: "" }, "Advertised optional root path agrees with the native default.");
    const claim = (await describe(client, "labels.claim")).inputSchema;
    assert.deepEqual(claim.required?.sort(), ["deviceId", "deviceToken", "issuanceId"]);
    assert.equal(claim.properties?.deviceToken.writeOnly, true); assert.equal(claim.properties?.deviceToken.minLength, 30);
    const report = (await describe(client, "labels.delivery.report")).inputSchema;
    assert.equal(report.properties?.reportToken.writeOnly, true);
    assert.deepEqual(report.properties?.status.enum, ["sent_unconfirmed", "unknown", "not_sent"]);
    const publish = (await describe(client, "payloads.publish")).inputSchema;
    assert.deepEqual(publish.required?.sort(), ["expectedRevision", "id", "note", "reviewedNoSecrets"]); assert.equal(publish.properties?.reviewedNoSecrets.const, true);
    const create = (await describe(client, "payloads.create")).inputSchema;
    assert.equal(create.required?.includes("protocolVersion"), false); assert.equal(create.properties?.protocolVersion.default, 1);
    assert.equal(create.required?.includes("operationNames"), false); assert.deepEqual(create.properties?.operationNames.default, []);
    assert.ok((await describe(client, "route-recon.preview")).inputSchema.properties?.contentBase64.maxLength);
    assert.deepEqual((await describe(client, "labels.rtv.parse")).inputSchema.required, ["text"]);
    const render = (await describe(client, "labels.rtv.render")).inputSchema;
    assert.deepEqual(render.required?.sort(), ["fields", "templateId"]); assert.equal(render.properties?.fields.properties?.submissionNumber.type, "string");
    assert.deepEqual((await describe(client, "labels.rtv.bookmarklet")).inputSchema.properties, {});
    assert.deepEqual((await describe(client, "scanner.diagnostics.open")).inputSchema.properties, {});
    const ceremony = await describe(client, "identity.password.change");
    assert.equal(ceremony.requiresUserInteraction, true); assert.deepEqual(ceremony.inputSchema.properties, {}, "The agent initiates a human ceremony without collecting password/authenticator credentials.");
    assert.equal(JSON.stringify(claim).includes("synthetic-discovery-only"), false, "Schemas contain credential requirements, never an active credential.");
  } finally { await connection.close(); }
});

test("SDK-discovered inputs execute the native draft and scan-list commands with attribution, CAS and shared validation", { skip: !process.env.DATABASE_URL }, async () => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.ok(target.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_test", "Dedicated local synthetic database required.");
  const { prisma } = await import("../lib/db");
  const suffix = randomUUID(), payloadId = `schema-${suffix}`, purpose = "office_disposition";
  let userId = "", bundleId = "", workflowCreated = false, payloadCreated = false;
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    assert.equal(await prisma.labelWorkflow.count({ where: { purpose } }), 0, "Preserve any existing workflow instead of overwriting it.");
    const bundle = await prisma.roleBundle.create({ data: { name: `Synthetic action discovery ${suffix}`, capabilities: [...CAPABILITIES] } }); bundleId = bundle.id;
    const user = await prisma.user.create({ data: { username: `schema-${suffix}`, displayName: "Synthetic MCP discovery operator", role: "admin", pinHash: "not-a-usable-credential", roleBundles: { create: { bundleId } } } }); userId = user.id;
    const at = new Date(), session = await prisma.userSession.create({ data: { id: randomUUID(), userId, authVersion: user.authVersion, createdAt: at, lastActivityAt: at, lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 3600_000), deviceLabel: "Synthetic discovery" } });
    const resolved = await resolvePrincipal({ userId, authVersion: user.authVersion, sessionId: session.id, issuedAt: at.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    assert.ok(resolved);
    const actor: Principal = { ...resolved, sessionId: session.id, strongAuthenticatedAt: at.getTime(), mfaVerifiedAt: at.getTime() };
    connection = await connect(actor); const { client } = connection;
    const execute = (action: string, input: Record<string, unknown>) => client.callTool({ name: "application_action", arguments: { action, input } });
    const invalidMove = { operationId: randomUUID(), path: "../outside-root", destinationPath: "inside", expectedFingerprint: "a".repeat(64) };
    assert.throws(() => adminFileMoveInput.parse(invalidMove), /relative|traversal|path/i);
    const rejectedMove = await execute("files.move", invalidMove); assert.equal(rejectedMove.isError, true);
    assert.equal(await prisma.identityAudit.count({ where: { actorUserId: userId, action: { startsWith: "files." } } }), 0, "Invalid path fails before any filesystem intent or effect.");
    const draft = { purpose, name: "Synthetic schema label", zpl: "^XA^FD{{lpn}}^FS^XZ", requiredFields: ["lpn"], rules: [], widthMm: 102, heightMm: 76, dpi: 203, expectedRevision: 0, note: "Synthetic discovered draft" };
    assert.ok((await describe(client, "labels.draft.save")).inputSchema.required?.includes("expectedRevision"));
    const saved = await execute("labels.draft.save", draft); assert.notEqual(saved.isError, true); workflowCreated = true;
    assert.equal(body(saved).updatedByUserId, userId);
    const stale = await execute("labels.draft.save", { ...draft, name: "Stale replacement" }); assert.equal(stale.isError, true);
    await assert.rejects(saveLabelWorkflow(actor, { ...draft, name: "Same native stale replacement" }), /changed/);
    const { expectedRevision: omittedRevision, ...missingRevision } = draft; assert.equal(omittedRevision, 0);
    assert.equal(labelWorkflowSaveInput.safeParse(missingRevision).success, false);
    const invalid = await execute("labels.draft.save", missingRevision); assert.equal(invalid.isError, true); assert.match((invalid.content as { text: string }[])[0].text, /expectedRevision/);
    const payload = { id: payloadId, name: "Synthetic schema payload", purpose: "mars_label_helper", targetOrigins: ["https://integration.invalid"], source: "void 0;", note: "Synthetic unpublished draft" };
    const created = await execute("payloads.create", payload); assert.notEqual(created.isError, true); payloadCreated = true;
    const storedPayload = await prisma.payload.findUniqueOrThrow({ where: { id: payloadId } }); assert.equal(storedPayload.protocolVersion, 1); assert.deepEqual(storedPayload.operationNames, []); assert.equal(storedPayload.publishedVersionId, null);
    assert.equal(payloadDraftSaveInput.safeParse(payload).success, false);
    const missingPayloadRevision = await execute("payloads.draft.save", payload); assert.equal(missingPayloadRevision.isError, true); assert.match((missingPayloadRevision.content as { text: string }[])[0].text, /expectedRevision/);
    assert.equal((await prisma.payload.findUniqueOrThrow({ where: { id: payloadId } })).revision, storedPayload.revision);
    assert.deepEqual(body(await execute("payloads.versions", { id: payloadId })), { versions: [], nextBeforeVersion: null });
    const scanInput = { localDraftId: randomUUID(), name: "Synthetic discovered scan list", createdAt: at.toISOString(), scans: [{ value: `SYNTHETIC-${suffix}`, scannedAt: at.toISOString() }] };
    const scan = await execute("scan-lists.create", scanInput); assert.notEqual(scan.isError, true);
    const list = await prisma.scanListSession.findUniqueOrThrow({ where: { id: body(scan).id } });
    assert.equal(list.createdByUserId, userId); assert.equal((await prisma.warehousePhysicalObservation.count({ where: { userId } })), 0, "A saved generic list never creates physical stock/evidence.");
    const retry = await execute("scan-lists.create", scanInput); assert.notEqual(retry.isError, true); assert.deepEqual(body(retry), body(scan));
    assert.equal((await execute("scan-lists.create", { ...scanInput, name: "Conflicting retry" })).isError, true);
  } finally {
    await connection?.close();
    if (workflowCreated) { await prisma.labelWorkflowAudit.deleteMany({ where: { purpose } }); await prisma.labelWorkflow.delete({ where: { purpose } }); }
    if (payloadCreated) { await prisma.payloadAudit.deleteMany({ where: { payloadId } }); await prisma.payload.delete({ where: { id: payloadId } }); }
    if (userId) { await prisma.scanListSession.deleteMany({ where: { createdByUserId: userId } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: userId } }); await prisma.user.delete({ where: { id: userId } }); }
    if (bundleId) await prisma.roleBundle.delete({ where: { id: bundleId } });
    await prisma.$disconnect();
  }
});
