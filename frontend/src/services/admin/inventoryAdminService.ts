import type { AdminResult, InventoryItem, StockAdjustment } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Inventory.
 *
 * Rows are derived from products by the adapter, so there is no second source
 * of truth for stock. This service adds the reasons a change can have and the
 * counts the dashboard and sidebar need.
 */

/** Every product's stock, or — given a Product ID or SKU — just that product's. */
export function listInventory(productId?: string): Promise<InventoryItem[]> {
  return adminDataSource.listInventory(productId);
}

export function listStockLog(productId?: string): Promise<StockAdjustment[]> {
  return adminDataSource.listStockLog(productId);
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
