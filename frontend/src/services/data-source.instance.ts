import { httpAdapter } from "./adapters/http-adapter";
import type { DataSource } from "./data-source";

/**
 * The active storefront data source.
 *
 * One adapter now: the REST API. The contract it implements is the same one
 * the local-JSON adapter implemented, which is what made the switch a change
 * to this file rather than to every component.
 */
export const dataSource: DataSource = httpAdapter;
