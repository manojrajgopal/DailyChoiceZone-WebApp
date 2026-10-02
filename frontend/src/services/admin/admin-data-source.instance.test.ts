import { describe, expect, it } from "vitest";

import { adminDataSource } from "./admin-data-source.instance";
import { httpAdminAdapter } from "./adapters/http-admin-adapter";

describe("adminDataSource", () => {
  it("is the HTTP adapter — the one active admin data source", () => {
    expect(adminDataSource).toBe(httpAdminAdapter);
  });
});
