import { httpAdminAdapter } from "./adapters/http-admin-adapter";
import type { AdminDataSource } from "./admin-data-source";

/** The active portal data source — the REST API. */
export const adminDataSource: AdminDataSource = httpAdminAdapter;
