import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withApplicationSession } from "@/lib/auth/application-context";
import { authenticateAccessToken } from "./oauth";
import { ALL_ACTIONS, type AppAction } from "./catalog";
import { ROUTE_HANDLERS } from "./route-handlers";
import { createArtifact, artifactChunk } from "./artifacts";
import { mcpConfig, OAuthError } from "./config";
import { TOOLS } from "@/lib/tools";
import { getMarsOperationalOverview, getMarsUnitDetail, getRecentMarsImportBatches } from "@/lib/mars/inventory";
import { getMarsAuditDetail, listSubmittedMarsAuditSessions } from "@/lib/mars/audit";
import { MARS_BUCKET_LABELS } from "@/lib/mars/classification";
import { listPickWaves, getPickWave } from "@/lib/pick-waves";
import { listRouteRecons, getRouteRecon } from "@/lib/route-recons";
import { listScanLists, getScanList } from "@/lib/scan-lists";
import { prepareLpnReport } from "@/lib/lpn-report";
import { executePipeline, type Step } from "@/lib/pipeline/executePipeline";
import { parseFields, renderTemplate, DEFAULT_TEMPLATE_ZPL, type LabelFields } from "@/app/tools/rtv-label/marsLabelShared";
import { renderPickWaveLabel, DEFAULT_PICK_WAVE_TEMPLATE, type PickWaveLabelFields } from "@/components/pick-waves/pickWaveLabel";
import { revokeOwnDevices } from "@/lib/auth/identity";
import { buildTemplatePreview } from "@/lib/driver-paperwork/preview";
import { templateSchema } from "@/lib/driver-paperwork/templates";
import { printThroughRelay } from "./printing";
import { relayConnections, requestViaRelay } from "@/lib/api-relay/service";
import { listRelayDefinitions } from "@/lib/api-relay/definitions";
import JsBarcode from "jsbarcode";
import { DOMImplementation, XMLSerializer } from "@xmldom/xmldom";
import { parseSpreadsheet, reportWorkbook, uploadBytes } from "./spreadsheets";

type Principal = Awaited<ReturnType<typeof authenticateAccessToken>>;
export const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value));
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function describeAction(action: AppAction) { return { name: action.name, description: action.description, mode: action.mode, inputSchema: z.toJSONSchema(action.schema, { unrepresentable: "any" }), ...(action.mode === "write" ? { requiresOperationId: true } : {}) }; }
export function listActions(principal: Principal, prefix = "") { return ALL_ACTIONS.filter(action => action.name.startsWith(prefix) && (action.mode !== "write" || principal.grant.scopes.includes("temco.write"))).map(action => ({ name: action.name, description: action.description, mode: action.mode })); }
function selectAction(principal: Principal, name: string) {
  const action = ALL_ACTIONS.find(value => value.name === name);
  if (!action) throw new OAuthError("invalid_request", "Unknown application action.", 404);
  if (action.mode === "write" && !principal.grant.scopes.includes("temco.write")) throw new OAuthError("insufficient_scope", "This MCP client has read-only access.", 403);
  return action;
}
function sanitizedConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizedConfiguration);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => {
    if (key === "endpoint" && typeof item === "string") { try { const url = new URL(item); url.username = ""; url.password = ""; return [key,url.href]; } catch { return [key,item]; } }
    return [key,sanitizedConfiguration(item)];
  }));
  return value;
}
async function routeCall(action: AppAction, input: Record<string, unknown>, grantId: string) {
  const params = { ...(input.params as Record<string,string> || {}), ...action.fixedParams };
  const path = action.path!.replace(/\[([^\]]+)\]/g, (_, key: string) => encodeURIComponent(params[key]));
  const url = new URL(path, mcpConfig().issuer);
  for (const [key,value] of Object.entries(input.query || {})) url.searchParams.set(key, String(value));
  let body: BodyInit | undefined;
  const headers: Record<string,string> = { Origin: mcpConfig().issuer };
  if (input.files) {
    const form = new FormData(); let total = 0;
    for (const [key,value] of Object.entries(input.form || {})) form.set(key, String(value));
    for (const file of input.files as { field: string; filename: string; contentType: string; dataBase64: string }[]) {
      const bytes = uploadBytes(file); total += bytes.length;
      if (total > 20 * 1024 * 1024) throw new OAuthError("invalid_request", "MCP file uploads are limited to 20 MB per action.");
      form.append(file.field, new File([new Uint8Array(bytes)], file.filename, { type: file.contentType }));
    }
    body = form;
  } else if (input.body !== undefined || !["GET","DELETE"].includes(action.method!)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(input.body || {}); }
  const request = new NextRequest(url, { method: action.method, headers, ...(body === undefined ? {} : { body }) });
  const loader = ROUTE_HANDLERS[`${action.method} ${action.path}`];
  if (!loader) throw new Error("Missing native action handler");
  const response = await (await loader())(request, { params: Promise.resolve(params) });
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (response.status >= 300 && response.status < 400) throw new OAuthError("access_denied", "The application denied this action.", 403);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (contentType.includes("application/json")) {
    const result = JSON.parse(bytes.toString("utf8"));
    if (response.status >= 500) return { outcome: "unknown", httpStatus: response.status, result, instruction: "Check current application state. Do not automatically retry this write." };
    return { httpStatus: response.status, result: action.name.startsWith("labels.") ? sanitizedConfiguration(result) : result };
  }
  if (!response.ok) return { httpStatus: response.status, error: "The application could not produce this download." };
  const disposition = response.headers.get("content-disposition") || "";
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] || `${action.name}.txt`;
  return createArtifact(grantId, bytes, filename, contentType);
}
async function serviceCall(action: string, input: Record<string, unknown>, principal: Principal, token: string, operationId?: string): Promise<unknown> {
  const actor = principal.actor;
  switch (action) {
    case "tools.list": return { tools: TOOLS };
    case "account.current": return { userId: actor.userId, username: actor.username, displayName: actor.displayName, role: actor.role, deviceId: actor.sessionId, scopes: principal.grant.scopes };
    case "account.devices.revoke": return revokeOwnDevices(actor, input.sessionId as string || null);
    case "account.sign_out": return revokeOwnDevices(actor, actor.sessionId!);
    case "mars.overview": return getMarsOperationalOverview();
    case "mars.unit": return getMarsUnitDetail(input.requestNumber as string);
    case "mars.imports": return getRecentMarsImportBatches(input.limit as number);
    case "mars.audits": return listSubmittedMarsAuditSessions(input.limit as number);
    case "mars.audit.detail": return getMarsAuditDetail(input.auditSessionId as string);
    case "mars.status_rules": return { buckets: MARS_BUCKET_LABELS, rules: ["RECEIVED → Received / Archived", "SHIPPED → Shipped", "Vendor RA DENIED → Denied", "NOT RECEIVED → Problems", "NOT SHIPPED / AWAITING PICKUP → Awaiting Pickup", "ADDED TO PICKUP / RESCHEDULED / MISSED → Pickup Cycle", "REMOVED FROM PICKUP / missing / unmapped → Problems"] };
    case "pick_waves.list": return listPickWaves();
    case "pick_waves.get": return getPickWave(input.id as string);
    case "scan_lists.list": return listScanLists();
    case "scan_lists.get": return getScanList(input.id as string);
    case "route_recon.list": return listRouteRecons();
    case "route_recon.get": return getRouteRecon(input.id as string);
    case "lpn.prepare": return prepareLpnReport(input.rows as Record<string,unknown>[]);
    case "spreadsheets.parse": return parseSpreadsheet(input.file as { filename: string; dataBase64: string }, input.sheet as string | undefined);
    case "reports.execute": return executePipeline(input.rows as Record<string,unknown>[], input.steps as Step[]);
    case "reports.export": {
      const rows = input.rows as Record<string,unknown>[], keys = [...new Set(rows.flatMap(Object.keys))];
      if (input.format === "xlsx") return createArtifact(principal.grant.id, reportWorkbook(rows), "report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"','""')}"`;
      const csv = [keys.map(cell).join(","),...rows.map(row => keys.map(key => cell(row[key])).join(","))].join("\r\n");
      return createArtifact(principal.grant.id, Buffer.from(csv), "report.csv", "text/csv; charset=utf-8");
    }
    case "labels.mars.parse": return parseFields(input.text as string);
    case "labels.mars.render": return { zpl: renderTemplate(input.template as string || DEFAULT_TEMPLATE_ZPL, input.fields as unknown as LabelFields) };
    case "labels.pick_wave.render": return { zpl: renderPickWaveLabel(input.template as string || DEFAULT_PICK_WAVE_TEMPLATE, input.fields as unknown as PickWaveLabelFields) };
    case "labels.print": return printThroughRelay(token, input.printerId as string, input.zpl as string, operationId!);
    case "barcodes.generate": {
      const values = input.values as string[], implementation = new DOMImplementation();
      const images = values.map(value => { const document = implementation.createDocument("http://www.w3.org/1999/xhtml", "html", null); const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); JsBarcode(svg, value, { xmlDocument: document as unknown as XMLDocument, format: "CODE128", displayValue: true }); return new XMLSerializer().serializeToString(svg); });
      return createArtifact(principal.grant.id, Buffer.from(`<!doctype html><meta charset="utf-8"><title>TemcoTools barcodes</title><style>body{font-family:sans-serif}.label{break-inside:avoid;display:inline-block;padding:12px}svg{max-width:100%}</style>${images.map(svg=>`<div class="label">${svg}</div>`).join("")}`), "barcodes.html", "text/html; charset=utf-8");
    }
    case "driver_paperwork.preview": return createArtifact(principal.grant.id, Buffer.from(buildTemplatePreview(templateSchema.parse(input.template), input.program as string, randomUUID())), "paperwork-preview.html", "text/html; charset=utf-8");
    case "relays.read": {
      const owner = { userId: actor.userId, sessionId: actor.sessionId! };
      const connection = (await relayConnections(owner)).find(value => value.id === input.connectionId);
      const definition = connection && (await listRelayDefinitions()).find(value => value.id === connection.relayId);
      const method = definition?.operations[input.operation as string]?.method || "GET";
      if (!connection || !definition || !["GET","HEAD"].includes(method)) throw new OAuthError("insufficient_scope", "Read-only relay calls require a configured GET/HEAD operation.", 403);
      return requestViaRelay(owner, input.connectionId as string, input.operation as string, input.input);
    }
    case "mcp.operation": return prisma.mcpOperation.findUnique({ where: { grantId_operationId: { grantId: principal.grant.id, operationId: input.operationId as string } }, select: { operationId: true, action: true, state: true, result: true, createdAt: true, updatedAt: true } });
    case "mcp.artifact": return artifactChunk(principal.grant.id, input.id as string, input.offset as number, input.length as number);
    default: throw new Error("Missing application service action");
  }
}
export async function executeAction(rawToken: string, name: string, input: unknown, operationId?: string) {
  const principal = await authenticateAccessToken(rawToken), action = selectAction(principal, name);
  const parsed = action.schema.safeParse(input || {});
  if (!parsed.success) throw new OAuthError("invalid_request", "Invalid action input. Read application_action_info for the input schema.");
  const data = parsed.data as Record<string,unknown>;
  if (action.mode === "browser") return { status: "requires_user_interaction", action: name, url: new URL(action.href!, mcpConfig().issuer).href, instruction: action.description };
  let receiptId: string | undefined;
  if (action.mode === "write") {
    if (!z.uuid().safeParse(operationId).success) throw new OAuthError("invalid_request", "Supply a unique operationId UUID for a write. Reuse it to reconcile a lost response.");
    const digest = createHash("sha256").update(stable({ name, input: data })).digest("hex");
    const reservation = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110122)`;
      const old = await tx.mcpOperation.findUnique({ where: { grantId_operationId: { grantId: principal.grant.id, operationId: operationId! } } });
      if (old) { if (old.inputHash !== digest || old.action !== name) throw new OAuthError("invalid_request", "This operationId belongs to a different action/input.", 409); return { old }; }
      const row = await tx.mcpOperation.create({ data: { grantId: principal.grant.id, operationId: operationId!, action: name, inputHash: digest, state: "pending" } });
      return { id: row.id };
    });
    if (reservation.old) return reservation.old.state === "completed" ? reservation.old.result : { outcome: "unknown", operationId, state: reservation.old.state, instruction: "The earlier write may have taken effect. Reconcile current application state; it was not dispatched again." };
    receiptId = reservation.id;
  }
  try {
    // Token, device and current admin role are rechecked after reservation and by
    // every native route's getSession(). No cookies or service impersonation.
    const result = await withApplicationSession(async () => (await authenticateAccessToken(rawToken)).actor, async () => {
      await authenticateAccessToken(rawToken);
      return action.path ? routeCall(action, data, principal.grant.id) : serviceCall(name, data, principal, rawToken, operationId);
    });
    let safe = jsonValue(result);
    if (Buffer.byteLength(JSON.stringify(safe)) > 256 * 1024 && name !== "mcp.artifact") safe = await createArtifact(principal.grant.id, Buffer.from(JSON.stringify(safe)), `${name}.json`, "application/json");
    await prisma.$transaction(async tx => {
      if (receiptId) await tx.mcpOperation.update({ where: { id: receiptId }, data: { state: safe?.outcome === "unknown" ? "unknown" : "completed", result: safe } });
      await tx.authAudit.create({ data: { action: "mcp_action", actorUserId: principal.actor.userId, sessionId: principal.actor.sessionId, reason: `${name}${operationId ? ` · ${operationId}` : ""}` } });
    });
    return safe;
  } catch (error) {
    if (receiptId) {
      const result = { outcome: "unknown", operationId, instruction: "Check the application's current state before any new write. This operation was not automatically retried." };
      await prisma.mcpOperation.updateMany({ where: { id: receiptId }, data: { state: "unknown", result } });
      return result;
    }
    throw error;
  }
}
