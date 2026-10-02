import { afterEach, describe, expect, it } from "vitest";

import { makePayment } from "@/test/sliceA-fixtures";
import { api, ok } from "@/test/api";

import {
  capturePayment,
  getPaymentById,
  getPaymentByOrderId,
  getPayments,
  paymentMethodLabel,
  refundableAmount,
  setPaymentMethodLabels,
} from "./paymentService";

afterEach(() => {
  setPaymentMethodLabels({});
});

describe("paymentMethodLabel", () => {
  it("uses the store's own label when set", () => {
    setPaymentMethodLabels({ upi: "Instant UPI" });
    expect(paymentMethodLabel("upi")).toBe("Instant UPI");
  });

  it("falls back to the standard label for a method not yet configured", () => {
    expect(paymentMethodLabel("netbanking")).toBe("Net banking");
    expect(paymentMethodLabel("cod")).toBe("Cash on delivery");
  });

  it("falls back to the raw id for a completely unknown method", () => {
    expect(paymentMethodLabel("bitcoin")).toBe("bitcoin");
  });
});

describe("reading", () => {
  it("getPayments / getPaymentById / getPaymentByOrderId delegate to the admin billing routes", async () => {
    api.get("/admin/billing/payments", ok([makePayment()]));
    await getPayments({ status: "paid" });
    expect(api.last()!.query.get("status")).toBe("paid");

    api.get("/admin/billing/payments/PAY1", makePayment({ id: "PAY1" }));
    expect((await getPaymentById("PAY1"))?.id).toBe("PAY1");

    api.get(/\/admin\/billing\/payments/, ok([makePayment({ id: "PAY1" })]));
    expect((await getPaymentByOrderId("ORD1"))?.id).toBe("PAY1");
  });
});

describe("capturePayment", () => {
  it("POSTs to capture the payment", async () => {
    api.post("/admin/billing/payments/PAY1/capture", makePayment({ id: "PAY1", status: "paid" }));
    const result = await capturePayment(makePayment({ id: "PAY1" }));
    expect(result.status).toBe("paid");
  });
});

describe("refundableAmount", () => {
  it.each([
    ["failed", 10000, 0, 0],
    ["pending", 10000, 0, 0],
    ["paid", 10000, 0, 10000],
    ["paid", 10000, 4000, 6000],
    ["paid", 10000, 10000, 0],
    ["paid", 10000, 15000, 0], // never negative
  ] as [string, number, number, number][])("status=%s amount=%s refunded=%s => %s", (status, amount, refundedAmount, expected) => {
    expect(refundableAmount(makePayment({ status: status as never, amount, refundedAmount }))).toBe(expected);
  });
});
