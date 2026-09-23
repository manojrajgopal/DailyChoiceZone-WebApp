import { mockAdminAdapter } from "./adapters/mock-admin-adapter";
import type { AdminDataSource } from "./admin-data-source";

/**
 * Chooses the active admin data source.
 *
 * Mirrors the storefront's `data-source.instance`. When an admin API exists,
 * add `httpAdminAdapter` and switch on the same
 * `NEXT_PUBLIC_DATA_SOURCE` flag the storefront already uses — one variable
 * moves the whole application onto the backend.
 */
export const adminDataSource: AdminDataSource = mockAdminAdapter;
