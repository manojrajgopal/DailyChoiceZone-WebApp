import { httpBillingAdapter } from "./adapters/http-billing-adapter";
import type { BillingDataSource } from "./billing-data-source";

/** The active billing data source — the REST API. */
export const billingDataSource: BillingDataSource = httpBillingAdapter;
