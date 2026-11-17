import { z } from "zod";
import { relaySaveInput } from "@/lib/api-relay/model";
import { saveSchema, templateSchema } from "@/lib/driver-paperwork/templates";
export type ActionMode = "read" | "write" | "browser";
export type AppAction = { name: string; description: string; mode: ActionMode; schema: z.ZodType; method?: string; path?: string; service?: string; href?: string; fixedParams?: Record<string, string> };
const text = z.string().max(10000), id = z.string().min(1).max(200), str = z.string().max(1000), row = z.record(z.string(), z.unknown());
export const uploadSchema = z.object({ field: z.string().min(1).max(50).default("file"), filename: z.string().min(1).max(255), contentType: z.string().max(100).default("application/octet-stream"), dataBase64: z.string().max(28_000_000) }).strict();
const files = z.array(uploadSchema).min(1).max(10);
const query = z.record(z.string().max(80), z.union([z.string().max(10000), z.number().finite(), z.boolean()])).optional();
const empty = z.object({}).strict();
function route(name: string, description: string, mode: ActionMode, method: string, path: string, body?: z.ZodType, multipart = false): AppAction {
  const fixedParams: Record<string,string> = path === "/api/api-relay/[action]" ? { action: ({ "relays.status": "status", "relays.request": "request", "relays.disconnect": "disconnect" } as Record<string,string>)[name] } : {};
  const params = Object.fromEntries([...path.matchAll(/\[([^\]]+)\]/g)].filter(match => !(match[1] in fixedParams)).map(match => [match[1], id]));
  return { name, description, mode, method, path, fixedParams, schema: z.object({ ...(Object.keys(params).length ? { params: z.object(params).strict() } : {}), ...(method === "GET" || method === "DELETE" ? { query } : {}), ...(body ? { body } : {}), ...(multipart ? { files, form: z.record(z.string().max(80), z.string().max(100000)).optional() } : {}) }).strict() };
}
const archive = z.object({ archived: z.boolean() }).strict();
const routeMappings = z.array(z.object({ routeNumber: str, stagingLocation: z.string().max(32).nullable() })).max(10000);
const pipelineStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("filter"), column: str, operator: z.enum(["eq","neq","contains","notcontains","gt","lt","gte","lte","isempty","notempty"]), value: str }).strict(),
  z.object({ type: z.literal("map"), from: str, to: str.nullable() }).strict(),
  z.object({ type: z.literal("sort"), column: str, direction: z.enum(["asc","desc"]) }).strict(),
  z.object({ type: z.literal("join"), rightData: z.array(row).max(100000), on: str, prefix: str }).strict(),
]);
const printer = z.object({ resource: z.literal("printer"), name: id, endpoint: z.string().max(2048), contentType: z.string().max(100).optional() }).strict();
const labelTemplate = z.object({ resource: z.literal("template"), name: id, kind: z.enum(["mars_return","pick_wave"]), zpl: z.string().min(1).max(100000) }).strict();
export const ACTIONS: readonly AppAction[] = [
  route("users.list", "Search accounts, migration state and active-device counts.", "read", "GET", "/api/admin/users"),
  route("users.create", "Create an account with a username, display name and role; password setup is performed privately in the browser.", "write", "POST", "/api/admin/users", z.object({ username: id, displayName: z.string().min(1).max(100), role: z.enum(["user","manager","admin"]).optional() }).strict()),
  route("users.update", "Edit username/display name/role/active state or sign out all devices. Use the current expectedAuthVersion from users.list.", "write", "PATCH", "/api/admin/users/[id]", z.object({ expectedAuthVersion: z.number().int().positive(), username: id.optional(), displayName: str.optional(), role: z.enum(["user","manager","admin"]).optional(), isActive: z.boolean().optional(), revokeSessions: z.boolean().optional() }).strict()),
  route("users.devices", "List one user's browser and MCP devices with activity and expiration; never returns credentials.", "read", "GET", "/api/admin/users/[id]/devices"),
  route("users.devices.revoke", "Sign out exactly one device belonging to the specified user.", "write", "DELETE", "/api/admin/users/[id]/devices", z.object({ sessionId: id }).strict()),
  route("users.legacy_policy", "Enable or disable legacy PIN entry into the restricted setup flow. Upgraded PINs remain disabled.", "write", "POST", "/api/admin/auth-policy", z.object({ legacyLoginEnabled: z.boolean() }).strict()),
  route("account.devices", "List your own signed-in browser and MCP devices.", "read", "GET", "/api/account/security"),
  route("mcp.connections", "View your MCP server URL and authorized clients, scopes and last use.", "read", "GET", "/api/account/mcp"),
  route("tools.favorites", "Read your favorite tools.", "read", "GET", "/api/tool-favorites"),
  route("tools.favorites.update", "Add/remove a tool favorite, or replace the favorite order using the same UI API.", "write", "PATCH", "/api/tool-favorites", z.discriminatedUnion("action", [z.object({ action: z.literal("set"), toolId: id, favorite: z.boolean() }).strict(), z.object({ action: z.literal("reorder"), order: z.array(id).max(100) }).strict()])),
  route("files.list", "List the shared file manager. Query path selects a folder.", "read", "GET", "/api/admin/files"),
  route("files.download", "Download a shared file or folder ZIP. Query path selects the item.", "read", "GET", "/api/admin/files/download"),
  route("files.upload", "Upload files to shared storage. Set file field to files; form.path chooses the target folder. Existing filenames are replaced.", "write", "POST", "/api/admin/files", undefined, true),
  route("files.mkdir", "Create a shared folder.", "write", "PUT", "/api/admin/files", z.object({ path: str.optional(), folderName: id }).strict()),
  route("files.delete", "Delete the file/folder at query.path, including its contents.", "write", "DELETE", "/api/admin/files"),
  route("inventory.list", "Browse inventory audit. Query supports archived, q, status, from, to, page and limit as in the UI.", "read", "GET", "/api/inventory-audit"),
  route("inventory.import", "Import parsed LPN report rows; spreadsheet cell values must be string, number, boolean or null.", "write", "POST", "/api/inventory-audit/import", z.object({ filename: z.string().min(1).max(255), rows: z.array(z.record(z.string().max(200), z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]))).min(1).max(100000) }).strict()),
  route("inventory.archive", "Archive or restore up to 100 inventory rows.", "write", "PATCH", "/api/inventory-audit", z.object({ ids: z.array(id).min(1).max(100), archived: z.boolean() }).strict()),
  route("inventory.export", "Export the filtered inventory audit to CSV.", "read", "GET", "/api/inventory-audit/export"),
  route("mars.units", "Search and filter MARS units. Query supports q, requestNumber, orderNumber, vendor, serialNumber, modelNumber, vendorRaNumber, requestStatus, returnStatus, replacementNeeded, staged, archived, bucket, returnStatusMode, needsAttentionOnly, dateRequestedOn, lastImportedOn, lastAuditSeenOn, sortBy, sortDirection, page, limit.", "read", "GET", "/api/mars/units"),
  route("mars.import", "Import a MARS workbook, using file field file.", "write", "POST", "/api/mars/import", undefined, true),
  route("mars.reconciliation", "Read MARS reconciliation and discrepancies.", "read", "GET", "/api/mars/reconciliation"),
  route("mars.stage", "Stage or unstage a MARS unit.", "write", "POST", "/api/mars/unit/[requestNumber]/stage", z.object({ staged: z.boolean() }).strict()),
  route("mars.archive", "Archive/restore a MARS unit with an optional reason.", "write", "POST", "/api/mars/unit/[requestNumber]/archive", z.object({ archived: z.boolean(), reason: str.optional() }).strict()),
  route("mars.audit.start", "Start a MARS audit.", "write", "POST", "/api/mars/audit/start", z.object({ notes: text.optional() }).strict()),
  route("mars.audit.scan", "Record an audit scan.", "write", "POST", "/api/mars/audit/scan", z.object({ auditSessionId: id, scannedValue: id }).strict()),
  route("mars.audit.complete", "Complete an open audit.", "write", "POST", "/api/mars/audit/complete", z.object({ auditSessionId: id }).strict()),
  route("mars.audit.submit", "Submit the collected local audit scans.", "write", "POST", "/api/mars/audit/submit", z.object({ scans: z.array(id).max(100000), deviceId: id.optional(), localAuditId: id.optional(), startedAt: str.optional(), completedAt: str.optional() }).strict()),
  route("mars.sighting", "Record a current MARS unit sighting.", "write", "POST", "/api/mars/audit/sighting", z.object({ requestNumber: id }).strict()),
  route("mars.audit.scan.add", "Add a manual audit scan.", "write", "POST", "/api/mars/audit/[auditSessionId]/scans", z.object({ scannedValue: id, manualEntry: z.boolean().optional() }).strict()),
  route("mars.audit.scan.delete", "Delete a saved audit scan.", "write", "DELETE", "/api/mars/audit/[auditSessionId]/scans/[scanId]"),
  route("mars.audit.report", "Generate a saved audit report snapshot.", "write", "POST", "/api/mars/audit/[auditSessionId]/reports", z.object({ label: str.optional() }).strict()),
  route("pick_waves.preview", "Preview an uploaded pick workbook before import.", "read", "POST", "/api/pick-waves/preview", undefined, true),
  route("pick_waves.create", "Create a pick wave. form.name is required; form.routeMappings is a JSON string array of routeNumber/stagingLocation. Include every route from the preview, with null for No Location.", "write", "POST", "/api/pick-waves", undefined, true),
  route("pick_waves.archive", "Archive or restore a pick wave.", "write", "PATCH", "/api/pick-waves/[id]", archive),
  route("pick_waves.routes", "Replace route/staging mappings, using configured staging locations.", "write", "PUT", "/api/pick-waves/[id]/routes", z.object({ routeMappings }).strict()),
  route("pick_waves.scan", "Scan an LPN or item in a pick wave.", "write", "POST", "/api/pick-waves/[id]/scan", z.object({ scannedValue: id }).strict()),
  route("pick_waves.save_scan_list", "Save pick wave scans to a Scan List.", "write", "POST", "/api/pick-waves/[id]/scan-list"),
  route("pick_waves.inventory_audit", "Export pick-wave scan results to Inventory Audit.", "write", "POST", "/api/pick-waves/[id]/inventory-audit"),
  route("pick_waves.locations", "List configured staging locations.", "read", "GET", "/api/pick-waves/locations"),
  route("pick_waves.locations.add", "Add a staging location.", "write", "POST", "/api/pick-waves/locations", z.object({ name: z.string().min(1).max(32) }).strict()),
  route("pick_waves.locations.remove", "Remove a staging location without altering existing assignments.", "write", "DELETE", "/api/pick-waves/locations", z.object({ name: z.string().min(1).max(32) }).strict()),
  route("scan_lists.save", "Save a collected scan list. localDraftId is an idempotent draft identifier.", "write", "POST", "/api/scan-lists", z.object({ localDraftId: id, name: str, createdAt: str, scans: z.array(z.object({ value: id, scannedAt: str })).max(100000) }).strict()),
  route("scan_lists.archive", "Archive or restore a scan list.", "write", "PATCH", "/api/scan-lists/[id]", archive),
  route("scan_lists.delete", "Delete a scan list.", "write", "DELETE", "/api/scan-lists/[id]"),
  route("scan_lists.export", "Export a scan list CSV.", "read", "GET", "/api/scan-lists/[id]/export"),
  route("route_recon.preview", "Preview a route reconciliation workbook.", "read", "POST", "/api/route-recons/preview", undefined, true),
  route("route_recon.create", "Create a route reconciliation from a workbook. form.name is required.", "write", "POST", "/api/route-recons", undefined, true),
  route("route_recon.archive", "Archive or restore a route reconciliation.", "write", "PATCH", "/api/route-recons/[id]", archive),
  route("labels.configuration", "Read the active printers and templates; query kind is mars_return or pick_wave.", "read", "GET", "/api/label-config"),
  route("labels.management", "Read shared printer/template configuration.", "read", "GET", "/api/management/label-config"),
  route("labels.create", "Create a shared printer or label template.", "write", "POST", "/api/management/label-config", z.discriminatedUnion("resource", [printer, labelTemplate])),
  route("labels.update", "Update a printer/template by id, supplying its current fields. Printer endpoints must be HTTP(S).", "write", "PATCH", "/api/management/label-config", z.discriminatedUnion("resource", [printer.extend({ id, isActive: z.boolean().optional() }), labelTemplate.extend({ id, isActive: z.boolean().optional(), isDefault: z.boolean().optional() })])),
  route("relays.status", "Read your enabled API relay definitions and valid live connections.", "read", "POST", "/api/api-relay/[action]", empty),
  route("relays.request", "Perform a named operation through your connected browser relay. Use relays.status for connection IDs and configured operations; never supplies an arbitrary URL.", "write", "POST", "/api/api-relay/[action]", z.object({ connectionId: id, operation: id, input: row.optional() }).strict()),
  route("relays.disconnect", "Disconnect one of your browser API relays.", "write", "POST", "/api/api-relay/[action]", z.object({ connectionId: id }).strict()),
  route("relays.manager", "Read API relay definitions and immutable version history.", "read", "GET", "/api/admin/api-relays"),
  route("relays.save", "Create/update a relay definition. Live connections must reconnect after a new revision. Keep the body's native operationId as well as the MCP operationId when reconciling a lost response.", "write", "POST", "/api/admin/api-relays", relaySaveInput),
  route("driver_paperwork.templates", "Read current templates/program and history; query version or operationId selects a revision.", "read", "GET", "/api/driver-paperwork/templates"),
  route("driver_paperwork.publish", "Publish templates and injection code. Preview the draft first. Keep the body's native operationId as well as the MCP operationId when reconciling a lost response.", "write", "POST", "/api/driver-paperwork/templates", saveSchema),
  route("driver_paperwork.payload", "Read the current public bookmarklet payload JavaScript.", "read", "GET", "/api/driver-paperwork/payload"),
];
function service(name: string, description: string, schema: z.ZodType = empty, mode: ActionMode = "read"): AppAction { return { name, description, schema, mode, service: name }; }
export const SERVICE_ACTIONS: readonly AppAction[] = [
  service("tools.list", "List all tools visible to the current administrator."),
  service("account.current", "Read the current account and MCP device identity without credentials."),
  service("account.devices.revoke", "Sign out one of your devices; omitting sessionId signs out all other devices.", z.object({ sessionId: id.optional() }).strict(), "write"),
  service("account.sign_out", "Sign out this MCP client immediately.", empty, "write"),
  service("mars.overview", "Read MARS operational overview and workflow buckets."),
  service("mars.unit", "Read one MARS unit's full detail and history.", z.object({ requestNumber: id }).strict()),
  service("mars.imports", "Read recent MARS import history.", z.object({ limit: z.number().int().min(1).max(100).default(10) }).strict()),
  service("mars.audits", "Read saved submitted MARS audits.", z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict()),
  service("mars.audit.detail", "Read audit scans, discrepancies and saved reports.", z.object({ auditSessionId: id }).strict()),
  service("mars.status_rules", "Explain MARS status classification."),
  ...["pick_waves", "scan_lists", "route_recon"].flatMap(family => [service(`${family}.list`, `List ${family.replaceAll("_", " ")} saved in the application.`), service(`${family}.get`, `Read one saved ${family.replaceAll("_", " ")} workspace.`, z.object({ id }).strict())]),
  service("lpn.prepare", "Prepare LPN Put Away rows with the same parser/normalization used by the UI.", z.object({ rows: z.array(row).max(100000) }).strict()),
  service("spreadsheets.parse", "Parse XLSX, legacy XLS or CSV into rows for lpn.prepare, reports.execute or inventory.import. Omit sheet to use the first worksheet; dates are returned as ISO strings.", z.object({ file: uploadSchema, sheet: str.optional() }).strict()),
  service("reports.execute", "Execute the Report Engine filter/map/sort/join pipeline on supplied rows.", z.object({ rows: z.array(row).max(100000), steps: z.array(pipelineStep).max(100) }).strict()),
  service("reports.export", "Export supplied report rows to XLSX (the UI default) or CSV.", z.object({ rows: z.array(row).max(100000), format: z.enum(["xlsx","csv"]).default("xlsx") }).strict()),
  service("labels.mars.parse", "Parse pasted MARS text into label fields using the UI parser.", z.object({ text }).strict()),
  service("labels.mars.render", "Render MARS return ZPL from fields using the shared label template.", z.object({ fields: z.record(z.string(), z.string().max(1000)), template: z.string().max(100000).optional() }).strict()),
  service("labels.pick_wave.render", "Render pick-wave staging ZPL from fields using the shared label template.", z.object({ fields: z.record(z.string(), z.string().max(1000)), template: z.string().max(100000).optional() }).strict()),
  service("labels.print", "Send ZPL to a configured printer through an active label relay. Outcomes may be uncertain after disconnect/timeout; never automatically reprint.", z.object({ printerId: id, zpl: z.string().min(1).max(100000) }).strict(), "write"),
  service("barcodes.generate", "Generate printable Code 128 barcodes as an HTML/SVG download.", z.object({ values: z.array(z.string().min(1).max(200)).min(1).max(500) }).strict()),
  service("driver_paperwork.preview", "Generate the same isolated synthetic-data template preview used by the editor.", z.object({ template: templateSchema, program: z.string().max(180000) }).strict()),
  service("relays.read", "Call a configured GET/HEAD relay operation. Read-only grants cannot invoke external write methods.", z.object({ connectionId: id, operation: id, input: row.optional() }).strict()),
  service("mcp.operation", "Reconcile one of this client's earlier write operations. A pending/unknown result must not be automatically retried with a new ID.", z.object({ operationId: z.uuid() }).strict()),
  service("mcp.artifact", "Read a private download in bounded base64 chunks. Follow nextOffset until null.", z.object({ id, offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(196608).default(49152) }).strict()),
];
const browser = (name: string, description: string, href: string): AppAction => ({ name, description, href, mode: "browser", schema: empty });
export const BROWSER_ACTIONS: readonly AppAction[] = [
  browser("account.password", "Set/change your own password in Account security; passwords are never MCP arguments.", "/account/security"),
  browser("users.setup_code", "Issue/deliver private account setup or recovery codes in User Management.", "/admin/users"),
  browser("mcp.authorize", "Start connection approval from the MCP client. Login/consent are completed in the browser and cannot self-approve over MCP.", "/configuration#mcp"),
  browser("relays.activate", "Activate the universal relay bookmarklet in the signed-in external system; browser cookies remain there.", "/configuration"),
  browser("labels.relay.configure", "Enable the label relay and select reachable printers on the physical browser device.", "/configuration#labels"),
  browser("driver_paperwork.activate", "Install/run the Driver Paperwork bookmarklet in the route manifest page.", "/tools/driver-paperwork"),
  browser("route_recon.print", "Open the route workspace and its physical print dialog.", "/tools/route-recon"),
  browser("scanner.diagnostic", "Test the physical scanner and keyboard on its assigned browser.", "/admin/scanner-diagnostic"),
  browser("preferences.theme", "Choose the theme on the browser whose local preferences should change.", "/"),
  browser("scan_lists.local_draft", "Capture or resume a browser-local offline scan draft; submit the resulting scans with scan_lists.save.", "/tools/scan-lists"),
];
export const ALL_ACTIONS = [...ACTIONS, ...SERVICE_ACTIONS, ...BROWSER_ACTIONS];
