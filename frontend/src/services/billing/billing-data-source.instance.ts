import { mockBillingAdapter } from "./adapters/mock-billing-adapter";
import type { BillingDataSource } from "./billing-data-source";

/**
 * Which billing adapter is live.
 *
 * The same switch the storefront and the portal use. When a billing API exists,
 * write `http-billing-adapter.ts` against the contract and select it here —
 * no service, hook or component changes.
 *
 * ```
 * NEXT_PUBLIC_BILLING_SOURCE=http
 * NEXT_PUBLIC_API_URL=https://api.dailychoicezone.com
 * ```
 */
export const billingDataSource: BillingDataSource = mockBillingAdapter;
