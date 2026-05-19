import NavBar from "@/components/NavBar";
import MarsInventoryScreen from "@/components/mars/MarsInventoryScreen";
import type { InventoryUrlState } from "@/components/mars/MarsInventoryClient";
import { requireAuth } from "@/lib/auth";
import {
  getMarsOperationalOverview,
  listMarsUnits,
  parseArchivedFilter,
  parseMarsOperationalBucket,
  parseMarsUnitSortField,
  parseSortDirection,
  parseStagedFilter,
} from "@/lib/mars/inventory";

type InventoryPageState = InventoryUrlState;

export default async function MarsInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuth();
  const params = await searchParams;
  const initialState = parseInventoryState(params);
  const [overview, initialResponse] = await Promise.all([
    getMarsOperationalOverview(),
    listMarsUnits(toListOptions(initialState)),
  ]);

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1400px] mx-auto px-4 py-6">
        <MarsInventoryScreen
          overview={overview}
          initialResponse={initialResponse}
          initialState={initialState}
        />
      </main>
    </div>
  );
}

function parseInventoryState(params: Record<string, string | string[] | undefined>): InventoryPageState {
  const get = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value ?? null;
  };
  const stagedValue = get("staged");
  const staged: InventoryPageState["filters"]["staged"] =
    stagedValue === "true" || stagedValue === "false" ? stagedValue : "all";

  return {
    filters: {
      q: get("q") ?? "",
      requestStatus: get("requestStatus") ?? "",
      returnStatus: get("returnStatus") ?? "",
      staged,
      archived: parseArchivedFilter(get("archived")) ?? false,
      bucket: parseMarsOperationalBucket(get("bucket")) ?? "",
    },
    sortBy: parseMarsUnitSortField(get("sortBy")),
    sortDirection: parseSortDirection(get("sortDirection")),
    page: Number(get("page") ?? "1"),
    pageSize: Number(get("limit") ?? "50"),
  };
}

function toListOptions(initialState: ReturnType<typeof parseInventoryState>) {
  return {
    q: initialState.filters.q,
    requestStatus: initialState.filters.requestStatus,
    returnStatus: initialState.filters.returnStatus,
    staged: parseStagedFilter(initialState.filters.staged),
    archived: initialState.filters.archived,
    bucket: initialState.filters.bucket || null,
    sortBy: initialState.sortBy,
    sortDirection: initialState.sortDirection,
    page: initialState.page,
    limit: initialState.pageSize,
  };
}
