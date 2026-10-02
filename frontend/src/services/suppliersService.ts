/**
 * The supplier directory and supplier–product links (permission `suppliers`).
 * Contract: docs/shipping-and-suppliers.md §6 "Admin: suppliers".
 *
 * Calls throw `ApiError`; the views turn its `code` and `details` into field
 * errors, a toast, or the "your role doesn't include suppliers" state.
 */
import type {
  Supplier,
  SupplierDetail,
  SupplierInput,
  SupplierPage,
  SupplierProduct,
  SupplierProductInput,
  SupplierSort,
  SupplierStatus,
} from "@/types/suppliers";

import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

const ADMIN = { auth: "admin" } as const;
const id = encodeURIComponent;

export interface SupplierFilters {
  q?: string;
  status?: string;
  sort?: SupplierSort | "";
  page?: number;
  pageSize?: number;
}

/** Everything but archived unless `status` says otherwise — the server's default. */
export function listSuppliers(filters: SupplierFilters = {}): Promise<SupplierPage> {
  return apiGet(`/admin/suppliers${query({ ...filters })}`, ADMIN);
}

export function getSupplier(supplierId: string): Promise<SupplierDetail> {
  return apiGet(`/admin/suppliers/${id(supplierId)}`, ADMIN);
}

export function createSupplier(input: SupplierInput): Promise<Supplier> {
  return apiPost(`/admin/suppliers`, input, ADMIN);
}

export function updateSupplier(supplierId: string, input: SupplierInput): Promise<Supplier> {
  return apiPut(`/admin/suppliers/${id(supplierId)}`, input, ADMIN);
}

export function setSupplierStatus(supplierId: string, status: SupplierStatus): Promise<Supplier> {
  return apiPost(`/admin/suppliers/${id(supplierId)}/status`, { status }, ADMIN);
}

/* ------------------------------------------------------ supplier–product */

export function listSupplierProducts(supplierId: string): Promise<SupplierProduct[]> {
  return apiGet(`/admin/suppliers/${id(supplierId)}/products`, ADMIN);
}

export function addSupplierProduct(
  supplierId: string,
  input: SupplierProductInput & { productId: string },
): Promise<SupplierProduct> {
  return apiPost(`/admin/suppliers/${id(supplierId)}/products`, input, ADMIN);
}

export function updateSupplierProduct(linkId: number, input: SupplierProductInput): Promise<SupplierProduct> {
  return apiPut(`/admin/supplier-products/${linkId}`, input, ADMIN);
}

export function removeSupplierProduct(linkId: number): Promise<unknown> {
  return apiDelete(`/admin/supplier-products/${linkId}`, ADMIN);
}

/** The suppliers of one product, for the product edit page. */
export function listProductSuppliers(productId: string): Promise<SupplierProduct[]> {
  return apiGet(`/admin/products/${id(productId)}/suppliers`, ADMIN);
}
