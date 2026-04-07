// ── Types ─────────────────────────────────────────────────────────────────────

export type FilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "notcontains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "isempty"
  | "notempty";

export interface FilterStep {
  type: "filter";
  column: string;
  operator: FilterOperator;
  value: string;
}

/** Rename a column (from → to) or drop it (to = null). */
export interface MapStep {
  type: "map";
  from: string;
  to: string | null;
}

export interface SortStep {
  type: "sort";
  column: string;
  direction: "asc" | "desc";
}

/** Left-join two row arrays on a shared key column. */
export interface JoinStep {
  type: "join";
  rightData: Record<string, unknown>[];
  on: string;
  prefix: string;
}

export type Step = FilterStep | MapStep | SortStep | JoinStep;

// ── Helpers ───────────────────────────────────────────────────────────────────

function coerce(v: unknown): number | string {
  const n = Number(v);
  return isNaN(n) ? String(v ?? "") : n;
}

// ── Step Implementations ──────────────────────────────────────────────────────

function applyFilter(
  data: Record<string, unknown>[],
  step: FilterStep
): Record<string, unknown>[] {
  return data.filter((row) => {
    const cellVal = row[step.column];
    const cell = String(cellVal ?? "").toLowerCase();
    const val = step.value.toLowerCase();
    switch (step.operator) {
      case "eq":
        return cell === val;
      case "neq":
        return cell !== val;
      case "contains":
        return cell.includes(val);
      case "notcontains":
        return !cell.includes(val);
      case "isempty":
        return cell === "";
      case "notempty":
        return cell !== "";
      case "gt":
        return coerce(cellVal) > coerce(step.value);
      case "lt":
        return coerce(cellVal) < coerce(step.value);
      case "gte":
        return coerce(cellVal) >= coerce(step.value);
      case "lte":
        return coerce(cellVal) <= coerce(step.value);
      default:
        return true;
    }
  });
}

function applyMap(
  data: Record<string, unknown>[],
  step: MapStep
): Record<string, unknown>[] {
  return data.map((row) => {
    const newRow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === step.from) {
        if (step.to !== null) {
          newRow[step.to] = value; // rename
        }
        // else: column is killed (omitted from newRow)
      } else {
        newRow[key] = value; // pass-through
      }
    }
    return newRow;
  });
}

function applySort(
  data: Record<string, unknown>[],
  step: SortStep
): Record<string, unknown>[] {
  // Spread creates a shallow copy so the original array is never mutated.
  return [...data].sort((a, b) => {
    const av = a[step.column];
    const bv = b[step.column];
    const aStr = String(av ?? "");
    const bStr = String(bv ?? "");
    // Push blanks to the bottom regardless of sort direction.
    if (aStr === "" && bStr !== "") return 1;
    if (aStr !== "" && bStr === "") return -1;
    const an = Number(av);
    const bn = Number(bv);
    let cmp: number;
    if (!isNaN(an) && !isNaN(bn)) {
      cmp = an - bn;
    } else {
      cmp = aStr.localeCompare(bStr);
    }
    return step.direction === "asc" ? cmp : -cmp;
  });
}

function applyJoin(
  data: Record<string, unknown>[],
  step: JoinStep
): Record<string, unknown>[] {
  const rightIndex = new Map<string, Record<string, unknown>>();
  for (const row of step.rightData) {
    const key = String(row[step.on] ?? "");
    rightIndex.set(key, row);
  }
  return data.map((row) => {
    const key = String(row[step.on] ?? "");
    const match = rightIndex.get(key);
    if (!match) return { ...row };
    const merged: Record<string, unknown> = { ...row };
    for (const [k, v] of Object.entries(match)) {
      if (k !== step.on) {
        merged[`${step.prefix}${k}`] = v;
      }
    }
    return merged;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a sequence of transformation steps against a row array.
 * Each step mutates a fresh copy; the original `data` array is never modified.
 */
export function executePipeline(
  data: Record<string, unknown>[],
  steps: Step[]
): Record<string, unknown>[] {
  return steps.reduce<Record<string, unknown>[]>(
    (acc, step) => {
      switch (step.type) {
        case "filter":
          return applyFilter(acc, step);
        case "map":
          return applyMap(acc, step);
        case "sort":
          return applySort(acc, step);
        case "join":
          return applyJoin(acc, step);
        default:
          return acc;
      }
    },
    [...data]
  );
}
