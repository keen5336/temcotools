import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../lib/db";
import { CURRENT_USER_SELECT, resolvePrincipal } from "../lib/auth/principal";
import { executePipeline } from "../lib/pipeline/executePipeline";
import { exportLegacyReport, generateBarcodes, importLegacyReport, parseRtvLabel, renderRtvLabel, runLegacyPipeline } from "../lib/application/utility-actions";
import { authenticateAccessGrant, createAccessGrant } from "../lib/application/grants";

test("retained report and label utilities share real transforms and current scoped authority", { skip: !process.env.DATABASE_URL }, async () => {
  const target = new URL(process.env.DATABASE_URL!); assert.ok(target.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_test");
  const prefix = `utility-${randomUUID()}`;
  const user = await prisma.user.create({ data: { username: prefix, displayName: "Synthetic utility operator", pinHash: "disabled:v2", roleBundles: { create: { bundleId: "legacy-user" } } } });
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic utility test", expiresAt: new Date(Date.now() + 60_000) } });
  const template = await prisma.labelTemplate.create({ data: { name: prefix, kind: "mars_return", zpl: "^XA^FO10,10^FD{{submissionNumber}}^FS^XZ" } });
  try {
    const actor = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT })); assert.ok(actor); actor.sessionId = session.id;
    const input = { rows: [{ Item: "Synthetic B", Count: 2 }, { Item: "Synthetic A", Count: 1 }], steps: [{ type: "sort" as const, column: "Item", direction: "asc" as const }] };
    const transformed = await runLegacyPipeline(actor, input); assert.deepEqual(transformed.rows, executePipeline(input.rows, input.steps));
    const exported = await exportLegacyReport(actor, input);
    const imported = await importLegacyReport(actor, { format: "xlsx", contentBase64: exported.contentBase64 }); assert.deepEqual(imported.rows, transformed.rows);
    const csv = await importLegacyReport(actor, { format: "csv", contentBase64: Buffer.from('Item,Note\r\nSYNTHETIC,"quoted\nline"\r\n').toString("base64") }); assert.equal(csv.rows[0].Note, "quoted\nline");
    const barcodes = await generateBarcodes(actor, { values: 'SYNTHETIC-001\n<script>alert("synthetic")</script>' }); assert.equal(barcodes.barcodes.length, 2); assert.ok(barcodes.barcodes.every(item => item.svg.startsWith("<svg") && !/<script|onload=|foreignObject/i.test(item.svg)));
    await assert.rejects(generateBarcodes(actor, { values: "SYNTHETIC\u0004" }));
    const parsed = await parseRtvLabel(actor, { text: "Submission #\nSYNTHETIC-RTV-1\nSerial #\nSERIAL-DEMO-A" }); assert.equal(parsed.fields.submissionNumber, "SYNTHETIC-RTV-1");
    const rendered = await renderRtvLabel(actor, { templateId: template.id, fields: { submissionNumber: "SYN^XZ\u0004THETIC" } }); assert.equal(rendered.zpl, "^XA^FO10,10^FDSYN XZ THETIC^FS^XZ"); assert.equal(rendered.physicalOutput, "not_printed");
    const grant = await createAccessGrant(actor, { clientName: "Synthetic inventory-only client", scopes: ["inventory.read"] });
    const narrow = await authenticateAccessGrant(grant.token); await assert.rejects(generateBarcodes(narrow, { values: "SYNTHETIC" })); await assert.rejects(runLegacyPipeline(narrow, input));
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }); await assert.rejects(generateBarcodes(actor, { values: "SYNTHETIC" }));
  } finally { await prisma.labelTemplate.delete({ where: { id: template.id } }); await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect(); }
});
