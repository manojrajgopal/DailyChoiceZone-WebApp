import { httpAdapter } from "./adapters/http-adapter";
import { mockAdapter } from "./adapters/mock-adapter";
import type { DataSource } from "./data-source";

/**
 * Chooses the active data source.
 *
 * This is the whole switch. `NEXT_PUBLIC_DATA_SOURCE=http` moves the entire
 * storefront onto the REST API; anything else keeps it on local JSON.
 */
export const dataSource: DataSource =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "http" ? httpAdapter : mockAdapter;
