import type { AdminResult, InventoryItem, StockAdjustment } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Inventory.
 *
 * Rows are derived from products by the adapter, so there is no second source
 * of truth for stock. This service adds the reasons a change can have and the
 * counts the dashboard and sidebar need.
 */

export const ADJUSTMENT_REASONS: { value: StockAdjustment["reason"]; label: string }[] = [
  { value: "restock", label: "Restock" },
  { value: "correction", label: "Correction" },
  { value: "damage", label: "Damaged or lost" },
  { value: "return", label: "Customer return" },
  { value: "stocktake", label: "Stocktake" },
];

export function listInventory(): Promise<InventoryItem[]> {
  return adminDataSource.listInventory();
}

export function listStockLog(): Promise<StockAdjustment[]> {
  return adminDataSource.listStockLog();
}

export async function adjustStock(
  input: Omit<StockAdjustment, "at">,
): Promise<AdminResult<InventoryItem>> {
  if (!Number.isFinite(input.newStock) || input.newStock < 0) {
    return { ok: false, reason: "Enter a stock quantity of zero or more." };
  }

  const adjustment: StockAdjustment = { ...input, at: new Date().toISOString() };
  return { ok: true, data: await adminDataSource.adjustStock(adjustment) };
}

/** Products in stock but at or below their threshold. Drives the alert badge. */
export async function countLowStock(): Promise<number> {
  const items = await adminDataSource.listInventory();
  return items.filter((item) => item.status === "low-stock").length;
}

export async function listLowStock(limit = 6): Promise<InventoryItem[]> {
  const items = await adminDataSource.listInventory();
  return items
    .filter((item) => item.status === "low-stock" || item.status === "out-of-stock")
    .sort((a, b) => a.available - b.available)
    .slice(0, limit);
}
