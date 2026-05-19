import type { Prisma } from "@prisma/client";

export const MARS_OPERATIONAL_BUCKETS = [
  "awaiting_pickup",
  "pickup_cycle",
  "shipped",
  "received",
  "problem",
] as const;

export type MarsOperationalBucket = (typeof MARS_OPERATIONAL_BUCKETS)[number];

export type MarsOperationalClassification = {
  bucket: MarsOperationalBucket;
  label: string;
  expectedInWarehouse: boolean;
  problemReasons: string[];
};

export type MarsClassifiableUnit = {
  requestStatus?: string | null;
  returnStatus: string | null;
  localStatus?: string | null;
  archivedAt?: Date | string | null;
  presentInLatestImport?: boolean | null;
  missingFromLatestImportAt?: Date | string | null;
  lastImportedAt?: Date | string | null;
  lastAuditSeenAt?: Date | string | null;
};

export const MARS_BUCKET_LABELS: Record<MarsOperationalBucket, string> = {
  awaiting_pickup: "Awaiting Pickup",
  pickup_cycle: "Pickup Cycle",
  shipped: "Shipped",
  received: "Received / Archived",
  problem: "Problems",
};

export function parseMarsOperationalBucket(value: string | null): MarsOperationalBucket | null {
  return MARS_OPERATIONAL_BUCKETS.includes(value as MarsOperationalBucket)
    ? (value as MarsOperationalBucket)
    : null;
}

export function classifyMarsUnit(
  unit: MarsClassifiableUnit,
  options: { seenInAudit?: boolean | null } = {}
): MarsOperationalClassification {
  const marsStatus = normalizeStatus(unit.returnStatus);
  const problemReasons: string[] = [];
  const seenInAudit = options.seenInAudit ?? false;

  if (unit.localStatus === "deleted" || unit.presentInLatestImport === false) {
    problemReasons.push("No longer present in the latest MARS import.");
  }

  if (matchesAny(marsStatus, ["removed from pickup"])) {
    problemReasons.push("Removed from pickup and needs review.");
  }

  if (matchesAny(marsStatus, ["not received"])) {
    problemReasons.push(
      seenInAudit
        ? "Vendor marked not received, and this audit found it physically present."
        : "Vendor marked not received; verify pickup proof, BOL, or physical location."
    );
  }

  if (isReceivedStatus(marsStatus)) {
    if (seenInAudit) {
      problemReasons.push("Marked received by the vendor but found in an audit.");
      return toClassification("problem", false, problemReasons);
    }
    return toClassification("received", false, problemReasons);
  }

  if (isShippedStatus(marsStatus)) {
    if (seenInAudit) {
      problemReasons.push("Marked shipped but found in an audit.");
      return toClassification("problem", false, problemReasons);
    }
    return toClassification("shipped", false, problemReasons);
  }

  if (problemReasons.length) {
    return toClassification("problem", false, problemReasons);
  }

  if (matchesAny(marsStatus, ["awaiting pickup", "not shipped"])) {
    return toClassification("awaiting_pickup", true, problemReasons);
  }

  if (matchesAny(marsStatus, ["added to pickup", "rescheduled", "missed"])) {
    return toClassification("pickup_cycle", true, problemReasons);
  }

  if (!marsStatus) {
    problemReasons.push("Missing MARS status.");
  } else {
    problemReasons.push(`Unmapped MARS status: ${displayStatus(unit)}.`);
  }

  return toClassification("problem", true, problemReasons);
}

export function getMarsBucketWhere(
  bucket: MarsOperationalBucket
): Prisma.MarsUnitWhereInput {
  const shipped = statusEquals(["shipped"]);
  const received = statusEquals(["received"]);
  const notReceived = statusEquals(["not received"]);
  const notShipped = statusEquals(["not shipped"]);
  const removed = statusEquals(["removed from pickup"]);
  const awaiting = statusEquals(["awaiting pickup date", "awaiting pickup"]);
  const pickupCycle = statusEquals(["added to pickup", "rescheduled", "missed"]);
  const notProblemBase: Prisma.MarsUnitWhereInput = {
    localStatus: { not: "deleted" },
    presentInLatestImport: true,
    NOT: [removed, notReceived],
  };
  const awaitingPickup = { OR: [awaiting, notShipped] };

  switch (bucket) {
    case "awaiting_pickup":
      return {
        AND: [notProblemBase, awaitingPickup, { NOT: [shipped, received] }],
      };
    case "pickup_cycle":
      return {
        AND: [notProblemBase, pickupCycle, { NOT: [shipped, received] }],
      };
    case "shipped":
      return {
        AND: [notProblemBase, shipped, { NOT: [received] }],
      };
    case "received":
      return {
        AND: [notProblemBase, received],
      };
    case "problem":
      return {
        OR: [
          notReceived,
          removed,
          {
            AND: [
              { NOT: [awaitingPickup, pickupCycle, shipped, received] },
            ],
          },
        ],
      };
  }
}

function toClassification(
  bucket: MarsOperationalBucket,
  expectedInWarehouse: boolean,
  problemReasons: string[]
): MarsOperationalClassification {
  return {
    bucket,
    label: MARS_BUCKET_LABELS[bucket],
    expectedInWarehouse,
    problemReasons,
  };
}

function statusEquals(terms: string[]): Prisma.MarsUnitWhereInput {
  return {
    OR: terms.map((term) => ({
      returnStatus: { equals: term, mode: "insensitive" as const },
    })),
  };
}

function normalizeStatus(value: string | null | undefined) {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

function matchesAny(status: string, terms: string[]) {
  return terms.some((term) => status.includes(term));
}

function isReceivedStatus(status: string) {
  return /\breceived\b/.test(status) && !matchesAny(status, ["not received"]);
}

function isShippedStatus(status: string) {
  return /\bshipped\b/.test(status) && !matchesAny(status, ["not shipped"]);
}

function displayStatus(unit: MarsClassifiableUnit) {
  return unit.returnStatus || "blank";
}
