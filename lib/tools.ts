import type { Capability } from "./auth/principal";
export type ToolRole = "admin" | "manager" | "user";
export type Tool = { id: string; name: string; href: string; description: string; roles?: readonly ToolRole[]; capability?: Capability; adminOnly?: boolean };

// One catalog keeps the dashboard and navigation in sync. Visibility here is
// presentation only; each tool still enforces its own server authorization.
export const TOOLS: readonly Tool[] = [
  { id: "security", name: "Account Security", href: "/account/security", description: "Manage strong sign-in, individual sessions, shared-device lock and recovery." },
  { id: "payloads", capability: "payloads.manage", adminOnly: true, name: "Bookmarklet Payloads", href: "/admin/payloads", description: "Admin source drafts, publication, immutable versions and stable mobile loaders.", roles: ["admin"] },
  { id: "relay-sites", capability: "payloads.manage", adminOnly: true, name: "Connect Site Mappings", href: "/admin/relay-sites", description: "Approved payloads for exact sites/paths with one Connect TemcoTools bookmark.", roles: ["admin"] },
  { id: "warehouse-scan", capability: "inventory.write", name: "Warehouse Observations", href: "/tools/warehouse-scan", description: "Capture presence, check-in, placement and physical departure with an attributed device queue." },
  { id: "warehouse", capability: "inventory.read", name: "Warehouse Lookup", href: "/tools/warehouse", description: "Scan an LPN or inspect order candidates with source rows and independent observation history." },
  { id: "office", capability: "workflow.read", name: "Office Cases & Returns", href: "/tools/office", description: "Review durable cases, expected returns, exact-unit instructions and exchange history." },
  { id: "dispatch", capability: "workflow.read", name: "Dispatch & Lane Verification", href: "/tools/dispatch", description: "Allocate exact units and confirm physical lanes against a versioned day snapshot; official source qualification is shown." },
  { id: "label-workflows", capability: "labels.manage", name: "Label Workflows", href: "/management/label-workflows", description: "Manage versioned label purposes, rules, previews and effect receipts.", roles: ["admin", "manager"] },
  { id: "access", name: "Your Connected Clients", href: "/account/access", description: "Create or revoke your scoped development MCP client grants." },
  { id: "api-relay", capability: "workflow.read", name: "DMP API Relay", href: "/tools/api-relay", description: "Connect your signed-in DMP tab and run API operations through your own account." },
  { id: "dmp-samples", capability: "workflow.read", name: "Private Source Samples", href: "/tools/dmp-samples", description: "Upload body-only DMP or Route Planner JSON/XML/CSV and inspect private structure with provenance." },
  { id: "mars", capability: "workflow.read", name: "MARS Tracking", href: "/tools/mars", description: "Import MARS spreadsheets, browse current units, run audits, and reconcile discrepancies." },
  { id: "rtv-label", capability: "labels.read", name: "MARS Label Tool", href: "/tools/rtv-label", description: "Generate and print MARS return shipping labels." },
  { id: "report-engine", capability: "workflow.read", name: "Report Engine (Legacy)", href: "/tools/report-engine", description: "Legacy CSV pipelines pending retirement; shared warehouse views are the v2 replacement." },
  { id: "lpn-put-away", capability: "inventory.read", name: "LPN Put Away", href: "/tools/lpn-put-away", description: "Use the shared WMS import to list Placing LPNs by received date." },
  { id: "inventory-audit", capability: "inventory.read", name: "Inventory Audit", href: "/tools/inventory-audit", description: "Review shared physical observations separately from reported WMS rows and retained Pick Wave audits." },
  { id: "barcode-generator", capability: "labels.read", name: "Barcode Generator", href: "/tools/barcode-generator", description: "Paste a list of values to generate and print a batch of barcodes." },
  { id: "scan-lists", capability: "workflow.read", name: "Scan Lists", href: "/tools/scan-lists", description: "Create named local scan sessions, save finished lists, and export them to CSV." },
  { id: "pick-waves", capability: "workflow.read", name: "Pick Waves", href: "/tools/pick-waves", description: "Upload pick lists, map route staging locations, scan items, and print staging labels." },
  { id: "route-recon", capability: "workflow.read", name: "Route Recon", href: "/tools/route-recon", description: "Organize pick lists by route and print readable item reports with scannable LPN barcodes." },
  { id: "files", capability: "files.manage", name: "File Manager", href: "/admin/files", description: "Upload, download, organize, and clear shared swap-space files.", roles: ["admin"] },
  { id: "labels", capability: "labels.manage", name: "Label Configuration", href: "/management/labels", description: "Manage shared printer destinations and workflow label templates.", roles: ["admin", "manager"] },
  { id: "users", capability: "users.manage", name: "User Management", href: "/admin/users", description: "Manage users, roles, and access.", roles: ["admin"] },
  { id: "scanner-diagnostic", capability: "diagnostics.use", name: "Scanner Diagnostic", href: "/admin/scanner-diagnostic", description: "Test focus-free scanner events, keyboard suppression, and scan acknowledgement.", roles: ["admin"] },
];

export function toolsForRole(role: ToolRole, capabilities?: readonly Capability[]) {
  return TOOLS.filter(tool => (!tool.adminOnly || role === "admin") && (capabilities ? !tool.capability || capabilities.includes(tool.capability) : !tool.roles || tool.roles.includes(role)));
}

export function visibleFavoriteIds(ids: readonly string[], role: ToolRole, capabilities?: readonly Capability[]) {
  const allowed = new Set(toolsForRole(role, capabilities).map((tool) => tool.id));
  return [...new Set(ids)].filter((id) => allowed.has(id));
}

export function toolSections(role: ToolRole, ids: readonly string[], capabilities?: readonly Capability[]) {
  const tools = toolsForRole(role, capabilities);
  const favorites = visibleFavoriteIds(ids, role, capabilities).map((id) => tools.find((tool) => tool.id === id)!);
  const starred = new Set(favorites.map((tool) => tool.id));
  return { favorites, remaining: tools.filter((tool) => !starred.has(tool.id)) };
}
