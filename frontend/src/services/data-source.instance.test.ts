import { describe, expect, it } from "vitest";

import { httpAdapter } from "./adapters/http-adapter";
import { dataSource } from "./data-source.instance";

describe("dataSource", () => {
  it("is wired to the HTTP adapter", () => {
    expect(dataSource).toBe(httpAdapter);
  });
});
