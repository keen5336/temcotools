import { marsApi } from "@/lib/mars/http";
import { listMarsInventory } from "@/lib/mars/service";
import { parseArchivedFilter, parseMarsUnitSortField, parseMarsOperationalBucket, parseReturnStatusMode, parseSortDirection, parseStagedFilter } from "@/lib/mars/inventory";
export const runtime = "nodejs";
export async function GET(request: Request) { return marsApi(principal => {
 const search = new URL(request.url).searchParams;
 const input = Object.fromEntries(["q","requestNumber","orderNumber","vendor","serialNumber","modelNumber","vendorRaNumber","requestStatus","returnStatus","replacementNeeded","dateRequestedOn","lastImportedOn","lastAuditSeenOn"].map(key => [key, search.get(key)]));
 return listMarsInventory(principal, { ...input, staged: parseStagedFilter(search.get("staged")), archived: parseArchivedFilter(search.get("archived")), bucket: parseMarsOperationalBucket(search.get("bucket")), returnStatusMode: parseReturnStatusMode(search.get("returnStatusMode")), needsAttentionOnly: search.get("needsAttentionOnly")==="true", sortBy: parseMarsUnitSortField(search.get("sortBy")), sortDirection: parseSortDirection(search.get("sortDirection")), page: Number(search.get("page") ?? "1"), limit: Number(search.get("limit") ?? "25") });
}); }
