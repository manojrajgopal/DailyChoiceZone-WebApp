import { describe, expect, it } from "vitest";

import { api, fail, ok } from "@/test/api";

import {
  PAYMENT_LINK_PARAMS,
  closeQr,
  createQr,
  getPaymentConfig,
  getPaymentMethods,
  getPaymentSession,
  pollQr,
  settlePaymentLink,
  verifyPayment,
} from "./paymentGatewayService";

describe("getPaymentConfig", () => {
  it("GETs the config and caches it for the page", async () => {
    api.get("/payments/config", { provider: "razorpay", keyId: "rzp_test", gateway: true, mode: "test" });
    const result = await getPaymentConfig();
    expect(result.mode).toBe("test");
    const before = api.requests("GET", "/payments/config").length;
    await getPaymentConfig();
    expect(api.requests("GET", "/payments/config")).toHaveLength(before);
  });
});

describe("getPaymentMethods", () => {
  it("GETs the available methods and caches for the page", async () => {
    api.get("/payments/methods", ok({ gateway: true, methods: ["upi", "card"], netbanking: [], wallet: [], upiIntent: true, upiQr: true, qrCodes: false }));
    const result = await getPaymentMethods();
    expect(result.methods).toEqual(["upi", "card"]);
    const before = api.requests("GET", "/payments/methods").length;
    await getPaymentMethods();
    expect(api.requests("GET", "/payments/methods")).toHaveLength(before);
  });
});

describe("createQr", () => {
  it("POSTs to mint a code, and resolves the image URL through apiImageSrc", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.post("/payments/PAY1/qr", { id: "QR1", imageUrl: "/media/qr/1.png", amount: 50000, status: "created" });
    const result = await createQr("PAY1");
    expect(result.id).toBe("QR1");
    expect(result.imageUrl).toBe("http://localhost:8000/api/media/qr/1.png");
    expect(api.last("POST")!.headers.authorization).toBe("Bearer cust");
  });
});

describe("pollQr / closeQr", () => {
  it("GETs the QR's status", async () => {
    api.get("/payments/PAY1/qr/QR1", { status: "created", paid: false });
    expect(await pollQr("PAY1", "QR1")).toEqual({ status: "created", paid: false });
  });

  it("DELETEs to close an abandoned code", async () => {
    api.delete("/payments/PAY1/qr/QR1", { closed: true });
    expect(await closeQr("PAY1", "QR1")).toEqual({ closed: true });
  });
});

describe("verifyPayment", () => {
  it("POSTs the gateway's three references and nothing about money", async () => {
    api.post("/payments/PAY1/verify", (req) => ({ status: "paid", echo: req.body }));
    const response = { razorpayPaymentId: "pay_1", razorpayOrderId: "order_1", razorpaySignature: "sig_1" };
    const result = await verifyPayment("PAY1", response);
    expect(result.status).toBe("paid");
    expect(api.last()!.body).toEqual(response);
  });

  it("propagates the server's rejection reason on failed verification", async () => {
    api.post("/payments/PAY1/verify", fail(422, "That payment belongs to a different order."));
    await expect(verifyPayment("PAY1", { razorpayPaymentId: "", razorpayOrderId: "", razorpaySignature: "" })).rejects.toMatchObject({
      status: 422, message: "That payment belongs to a different order.",
    });
  });
});

describe("getPaymentSession", () => {
  it("GETs the payment session with its own gateway handoff", async () => {
    api.get("/payments/PAY1/session", { status: "pending", orderNumber: "DCZ-1", gateway: null });
    const result = await getPaymentSession("PAY1");
    expect(result.gateway).toBeNull();
  });
});

describe("settlePaymentLink", () => {
  it("sends every payment-link param as a query string, without auth", async () => {
    api.get(/\/payments\/link-callback/, { orderNumber: "DCZ-1", paid: true });
    const params = {
      razorpay_payment_id: "pay_1",
      razorpay_payment_link_id: "plink_1",
      razorpay_payment_link_reference_id: "DCZ-1",
      razorpay_payment_link_status: "paid",
      razorpay_signature: "sig_1",
    };
    const result = await settlePaymentLink(params);
    expect(result.paid).toBe(true);
    const request = api.last()!;
    PAYMENT_LINK_PARAMS.forEach((key) => expect(request.query.get(key)).toBe(params[key]));
    expect(request.headers.authorization).toBeUndefined();
  });
});
