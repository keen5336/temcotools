import * as custody from "@/lib/warehouse/custody";
import { identityGapInput, listWarehouseIdentityGaps } from "@/lib/warehouse/identity-gaps";
import { z } from "zod";

export const custodyActions = {
  "custody.sites": { capability: "inventory.custody", description: "Minimal authorized warehouse selectors; selecting a destination grants no authority there", inputSchema: z.object({}).strict(), run: custody.listCustodySites },
  "custody.unit": { capability: "inventory.read", description: "Current warehouse participation, approved aliases and own private origin only", inputSchema: custody.custodyUnitInput, run: custody.getWarehouseUnitCustody },
  "custody.history": { capability: "inventory.read", description: "Page only transfers involving this warehouse, preserving a stable physical-unit identity", inputSchema: custody.custodyHistoryInput, run: custody.listUnitCustodyHistory },
  "custody.get": { capability: "inventory.read", description: "One participant-visible approved handoff and current warehouse events, without foreign private history", inputSchema: custody.custodyGetInput, run: custody.getUnitCustodyTransfer },
  "custody.propose": { capability: "inventory.custody", description: "Propose an exact unit and explicitly selected identifier/handoff fields; no movement or inherited execution authority", inputSchema: custody.custodyProposeInput, run: custody.proposeUnitCustody },
  "custody.accept": { capability: "inventory.custody", description: "Destination authority accepts a versioned proposal; expectation is not physical arrival", inputSchema: custody.custodyActionInput, run: custody.acceptUnitCustody },
  "custody.depart": { capability: "inventory.custody", description: "Confirm source departure from independent exact physical evidence/current revision; unavailable in isolated pilot", inputSchema: custody.custodyPhysicalInput, run: custody.departUnitCustody },
  "custody.check-in": { capability: "inventory.custody", description: "Confirm destination custody from a fresh exact check-in observation, never a planned route; unavailable in isolated pilot", inputSchema: custody.custodyPhysicalInput, run: custody.checkInUnitCustody },
  "custody.cancel": { capability: "inventory.custody", description: "Cancel an eligible proposal/acceptance with attribution; cannot fabricate return after departure", inputSchema: custody.custodyActionInput, run: custody.cancelUnitCustody },
  "warehouse.identity-gaps": { capability: "inventory.read", description: "Page current warehouse WMS source rows awaiting an evidenced identity/accepted transfer; no foreign identity disclosure", inputSchema: identityGapInput, run: listWarehouseIdentityGaps },
} as const;
