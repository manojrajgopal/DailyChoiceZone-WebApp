import { describe, expect, it } from "vitest";

import type { Address } from "@/types";
import { api, fail, ok } from "@/test/api";

import { deleteAddress, getAddresses, getDefaultAddress, saveAddress, setDefaultAddress } from "./accountService";

function makeAddress(overrides: Partial<Address> = {}): Address {
  return {
    id: "A1",
    fullName: "Asha Rao",
    phone: "9876543210",
    line1: "221B Baker Street",
    line2: "",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
    type: "home",
    isDefault: false,
    ...overrides,
  };
}

describe("getAddresses", () => {
  it("GETs the customer's addresses with the customer auth header", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/account/addresses", ok([makeAddress()]));
    const result = await getAddresses();
    expect(result).toHaveLength(1);
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("is an empty list rather than throwing when signed out / the request fails", async () => {
    api.get("/account/addresses", fail(401));
    await expect(getAddresses()).resolves.toEqual([]);
  });
});

describe("getDefaultAddress", () => {
  it("returns the address flagged as default", async () => {
    api.get("/account/addresses", ok([makeAddress({ id: "A1" }), makeAddress({ id: "A2", isDefault: true })]));
    const result = await getDefaultAddress();
    expect(result?.id).toBe("A2");
  });

  it("falls back to the first address when none is flagged default", async () => {
    api.get("/account/addresses", ok([makeAddress({ id: "A1" }), makeAddress({ id: "A2" })]));
    const result = await getDefaultAddress();
    expect(result?.id).toBe("A1");
  });

  it("is null when there are no addresses", async () => {
    api.get("/account/addresses", ok([]));
    expect(await getDefaultAddress()).toBeNull();
  });
});

describe("saveAddress", () => {
  it("POSTs a new address (no id) with India as the country", async () => {
    api.post("/account/addresses", (req) => ({ id: "NEW", ...(req.body as object) }));
    const result = await saveAddress({
      fullName: "Asha Rao",
      phone: "9876543210",
      line1: "221B Baker Street",
      line2: "",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      type: "home",
      isDefault: false,
    });
    expect(result.id).toBe("NEW");
    expect(api.last("POST")!.body).toMatchObject({ country: "India", fullName: "Asha Rao" });
  });

  it("PUTs to update an existing address (has id)", async () => {
    api.put("/account/addresses/A1", (req) => ({ id: "A1", ...(req.body as object) }));
    const result = await saveAddress({ ...makeAddress({ id: "A1" }) });
    expect(result.id).toBe("A1");
    expect(api.last("PUT")!.body).toMatchObject({ fullName: "Asha Rao" });
  });

  it("sends the customer auth header", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.post("/account/addresses", { id: "NEW" });
    await saveAddress({ ...makeAddress(), id: undefined });
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });
});

describe("deleteAddress", () => {
  it("DELETEs the address by id with auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.delete("/account/addresses/A1", {});
    await deleteAddress("A1");
    expect(api.last("DELETE")!.headers.authorization).toBe("Bearer cust");
  });

  it("propagates a server failure", async () => {
    api.delete("/account/addresses/A1", fail(500));
    await expect(deleteAddress("A1")).rejects.toMatchObject({ status: 500 });
  });
});

describe("setDefaultAddress", () => {
  it("re-saves the matching address with isDefault true", async () => {
    api.get("/account/addresses", ok([makeAddress({ id: "A1" }), makeAddress({ id: "A2" })]));
    api.put("/account/addresses/A2", (req) => req.body);
    await setDefaultAddress("A2");
    expect(api.last("PUT", "/account/addresses/A2")!.body).toMatchObject({ isDefault: true });
  });

  it("does nothing when the id doesn't match any address", async () => {
    api.get("/account/addresses", ok([makeAddress({ id: "A1" })]));
    await setDefaultAddress("missing");
    expect(api.requests("PUT")).toHaveLength(0);
  });
});
