import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliveryEstimate as Estimate } from "@/types/shipping";
import { act, renderUI, screen } from "@/test/render";
import { api, fail, hang, networkError } from "@/test/api";

import { DeliveryEstimate, ESTIMATE_DEBOUNCE_MS } from "./DeliveryEstimate";

function estimate(overrides: Partial<Estimate> = {}): Estimate {
  return {
    pincode: "570001",
    source: "store",
    serviceable: true,
    codAvailable: true,
    etaDays: { min: 3, max: 5 },
    label: "Delivery by Thu, 9 Oct",
    message: "",
    ...overrides,
  };
}

/** Let the debounce pass and the answer arrive. */
async function settle(ms = ESTIMATE_DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("DeliveryEstimate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the estimate once a full PIN code has been typed and typing has paused", async () => {
    api.get("/delivery/estimate", estimate({ message: "Cash on delivery available" }));
    renderUI(<DeliveryEstimate pincode=" 570001 " />);

    await settle(ESTIMATE_DEBOUNCE_MS - 1);
    expect(api.calls).toHaveLength(0);
    await settle(1);

    expect(screen.getByRole("status")).toHaveTextContent("Delivery by Thu, 9 Oct · Cash on delivery available");
    const request = api.last("GET", "/delivery/estimate")!;
    expect(request.query.get("pincode")).toBe("570001");
    expect(request.query.get("cod")).toBeNull();
    // Public: no token is sent.
    expect(request.headers.authorization).toBeUndefined();
  });

  it("passes COD along when asked", async () => {
    api.get("/delivery/estimate", estimate());
    renderUI(<DeliveryEstimate pincode="570001" cod />);
    await settle();
    expect(api.last("GET", "/delivery/estimate")!.query.get("cod")).toBe("true");
  });

  it.each(["", "57000", "0570001", "57000a", "5700011"])("asks nothing for an incomplete or invalid PIN code %j", async (pincode) => {
    api.get("/delivery/estimate", estimate());
    const { container } = renderUI(<DeliveryEstimate pincode={pincode} />);
    await settle(2_000);
    expect(api.calls).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });

  it("asks only for the PIN code typing stopped on", async () => {
    api.get("/delivery/estimate", (req) => estimate({ pincode: req.query.get("pincode")!, label: `Delivery to ${req.query.get("pincode")}` }));
    const { rerender } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle(100);
    rerender(<DeliveryEstimate pincode="560001" />);
    await settle();
    expect(api.requests("GET", "/delivery/estimate")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Delivery to 560001");
  });

  it("drops the estimate as soon as the PIN code changes, and never shows an older PIN's answer", async () => {
    api.get("/delivery/estimate", estimate());
    const { rerender, container } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle();
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<DeliveryEstimate pincode="57000" />);
    expect(container).toBeEmptyDOMElement();

    // Back to the same PIN: the earlier answer belongs to it again.
    rerender(<DeliveryEstimate pincode="570001" />);
    expect(screen.getByRole("status")).toHaveTextContent("Delivery by Thu, 9 Oct");
  });

  it("aborts the request for a PIN code that was changed while waiting", async () => {
    api.get("/delivery/estimate", (req) => (req.query.get("pincode") === "570001" ? hang() : estimate({ label: "Delivery by Fri, 10 Oct" })));
    const { rerender } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle();
    rerender(<DeliveryEstimate pincode="560001" />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Delivery by Fri, 10 Oct");
  });

  it.each([
    ["not serviceable", estimate({ serviceable: false, label: "" })],
    ["unknown (courier unreachable)", estimate({ serviceable: null, source: "none", label: "", etaDays: null, codAvailable: null })],
    ["serviceable without a label", estimate({ label: "" })],
    ["unknown but labelled", estimate({ serviceable: null, label: "Delivery by Thu, 9 Oct" })],
  ])("says nothing when the answer is %s", async (_, answer) => {
    api.get("/delivery/estimate", answer);
    const { container } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle();
    expect(api.calls).toHaveLength(1);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["a server error", fail(500)],
    ["a 422", fail(422, "Invalid pincode", "VALIDATION_ERROR")],
    ["a network failure", networkError()],
  ])("says nothing and throws nothing on %s", async (_, reply) => {
    api.get("/delivery/estimate", reply);
    const { container } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("gives up quietly on a request that never answers, after its short timeout", async () => {
    api.get("/delivery/estimate", hang());
    const { container } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    await settle(6_000);
    expect(container).toBeEmptyDOMElement();
    expect(api.calls).toHaveLength(1);
  });

  it("aborts the pending request on unmount", async () => {
    let signal: AbortSignal | undefined;
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return (original as typeof fetch)(input, init);
      }),
    );
    api.get("/delivery/estimate", hang());
    const { unmount } = renderUI(<DeliveryEstimate pincode="570001" />);
    await settle();
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("passes a class name through", async () => {
    api.get("/delivery/estimate", estimate());
    renderUI(<DeliveryEstimate pincode="570001" className="mt-2" />);
    await settle();
    expect(screen.getByRole("status")).toHaveClass("mt-2");
  });
});
