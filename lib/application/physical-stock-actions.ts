import { exportPhysicalStock, getPhysicalStock, physicalStockExportInput, physicalStockInput } from "@/lib/warehouse/physical-stock";
export const physicalStockActions = {
  "warehouse.physical-stock": { capability: "inventory.read", description: "Inventory Audit physical view: stable units and effective corrected observations; source rows/order are context, not stock proof. Sparse pages expose continuation.", inputSchema: physicalStockInput, run: getPhysicalStock },
  "warehouse.physical-stock.export": { capability: "inventory.read", description: "Export one bounded physical-view CSV part, with explicit continuation and accepted-evidence watermark; legacy report exports remain separate.", inputSchema: physicalStockExportInput, run: exportPhysicalStock },
} as const;
