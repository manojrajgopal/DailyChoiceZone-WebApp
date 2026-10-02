import { describe, expect, it } from "vitest";

import { httpBillingAdapter } from "./adapters/http-billing-adapter";
import { billingDataSource } from "./billing-data-source.instance";

describe("billingDataSource", () => {
  it("is wired to the HTTP billing adapter", () => {
    expect(billingDataSource).toBe(httpBillingAdapter);
  });
});
