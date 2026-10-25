export type ToolRole = "admin" | "manager" | "user";
export type Tool = { id: string; name: string; href: string; description: string; roles?: readonly ToolRole[] };

// One catalog keeps the dashboard and navigation in sync. Visibility here is
// presentation only; each tool still enforces its own server authorization.
export const TOOLS: readonly Tool[] = [
  { id: "api-relay", name: "DMP API Relay", href: "/tools/api-relay", description: "Connect your signed-in DMP tab and run API operations through your own account." },
  { id: "mars", name: "MARS Tracking", href: "/tools/mars", description: "Import MARS spreadsheets, browse current units, run audits, and reconcile discrepancies." },
  { id: "rtv-label", name: "MARS Label Tool", href: "/tools/rtv-label", description: "Generate and print MARS return shipping labels." },
  { id: "report-engine", name: "Report Engine", href: "/tools/report-engine", description: "Build data transformation pipelines on CSV files and export formatted reports." },
  { id: "lpn-put-away", name: "LPN Put Away", href: "/tools/lpn-put-away", description: "Upload an LPN report and list Placing LPNs by received date." },
  { id: "inventory-audit", name: "Inventory Audit", href: "/tools/inventory-audit", description: "Track every reported LPN, compare Pick Wave scans, and archive completed inventory." },
  { id: "barcode-generator", name: "Barcode Generator", href: "/tools/barcode-generator", description: "Paste a list of values to generate and print a batch of barcodes." },
  { id: "scan-lists", name: "Scan Lists", href: "/tools/scan-lists", description: "Create named local scan sessions, save finished lists, and export them to CSV." },
  { id: "pick-waves", name: "Pick Waves", href: "/tools/pick-waves", description: "Upload pick lists, map route staging locations, scan items, and print staging labels." },
  { id: "route-recon", name: "Route Recon", href: "/tools/route-recon", description: "Organize pick lists by route and print readable item reports with scannable LPN barcodes." },
  { id: "files", name: "File Manager", href: "/admin/files", description: "Upload, download, organize, and clear shared swap-space files.", roles: ["admin"] },
  { id: "labels", name: "Label Configuration", href: "/management/labels", description: "Manage shared printer destinations and workflow label templates.", roles: ["admin", "manager"] },
  { id: "users", name: "User Management", href: "/admin/users", description: "Manage users, roles, and access.", roles: ["admin"] },
  { id: "scanner-diagnostic", name: "Scanner Diagnostic", href: "/admin/scanner-diagnostic", description: "Test focus-free scanner events, keyboard suppression, and scan acknowledgement.", roles: ["admin"] },
];

export function toolsForRole(role: ToolRole) {
  return TOOLS.filter((tool) => !tool.roles || tool.roles.includes(role));
}

export function visibleFavoriteIds(ids: readonly string[], role: ToolRole) {
  const allowed = new Set(toolsForRole(role).map((tool) => tool.id));
  return [...new Set(ids)].filter((id) => allowed.has(id));
}

export function toolSections(role: ToolRole, ids: readonly string[]) {
  const tools = toolsForRole(role);
  const favorites = visibleFavoriteIds(ids, role).map((id) => tools.find((tool) => tool.id === id)!);
  const starred = new Set(favorites.map((tool) => tool.id));
  return { favorites, remaining: tools.filter((tool) => !starred.has(tool.id)) };
}
