import { describe, expect, it } from "vitest";

import type { TryOnEligibility, TryOnRequest } from "@/services/tryOnService";
import { api } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { signInCustomer } from "@/test/sliceD-acct3-session";

import { AccountTryOnView } from "./AccountTryOnView";

function usage(overrides: Partial<TryOnEligibility> = {}): TryOnEligibility {
  return {
    eligible: true, reason: "", source: "plan", planId: "MBP001", planName: "Prime", perPeriod: 10, usedThisPeriod: 3,
    remaining: 7, perDay: null, usedToday: 0, resetsAt: "2026-11-01T00:00:00", concurrent: 1, inProgress: 0, capabilities: [],
    maxUploadMb: 8, retention: "permanent", retentionDays: 7, ephemeralMinutes: 30, storageQuota: 50, storedResults: 4,
    download: true, history: true, retriesPerRequest: 2, allocationRequests: true, modelChoice: false, allocations: [], trial: null,
    ...overrides,
  };
}

function request(overrides: Partial<TryOnRequest> = {}): TryOnRequest {
  return {
    id: "VTR001", status: "succeeded", product: { id: "PRD002", name: "Linen Shirt", image: null }, color: "Blue", size: "M",
    capability: { key: "garment.upper_body", name: "Tops" }, model: null, queuePosition: null, etaSeconds: null, error: null,
    canRetry: false, canCancel: false,
    result: { available: true, mode: "permanent", expiresAt: null, downloadable: true, deleted: false },
    original: { available: false }, favourite: false, feedback: null, createdAt: "2026-10-09T10:00:00",
    startedAt: null, finishedAt: null, durationMs: 30000,
    ...overrides,
  };
}

const page = (items: TryOnRequest[]) => ({ items, pagination: { page: 1, page_size: 12, total: items.length, total_pages: 1 } });

describe("AccountTryOnView", () => {
  it("shows the allowance, the renewal date and how results are kept", async () => {
    signInCustomer();
    setLocation("/account/try-on");
    api.get("/try-on/eligibility", usage());
    api.get("/try-on/requests", page([]));
    renderUI(<AccountTryOnView />);
    expect(await screen.findByText("7 left")).toBeInTheDocument();
    expect(screen.getByText(/Prime · 3 of 10 used/)).toBeInTheDocument();
    expect(screen.getByText("Results are kept privately until you delete them.")).toBeInTheDocument();
    expect(screen.getByText("4 of 50 saved.")).toBeInTheDocument();
    expect(await screen.findByText("No try-ons yet")).toBeInTheDocument();
  });

  it("points a customer without try-on to the memberships", async () => {
    signInCustomer();
    setLocation("/account/try-on");
    api.get("/try-on/eligibility", usage({ eligible: false, reason: "plan_ineligible", source: "none" }));
    api.get("/try-on/requests", page([]));
    renderUI(<AccountTryOnView />);
    expect(await screen.findByText("Virtual try-on is a membership benefit")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "See memberships" })[0]).toHaveAttribute("href", "/membership");
  });

  it("lists try-ons with their status and filters by status", async () => {
    signInCustomer();
    setLocation("/account/try-on");
    api.get("/try-on/eligibility", usage());
    api.get("/try-on/requests", page([
      request(),
      request({ id: "VTR002", status: "failed", error: { code: "timeout", message: "Creating your try-on took too long. Please try again.", retryable: true }, canRetry: true }),
    ]));
    const { user } = renderUI(<AccountTryOnView />);
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Couldn't be created", { selector: "span" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Show"), "failed");
    await waitFor(() => expect(api.last("GET", "/try-on/requests")!.query.get("status")).toBe("failed"));
  });

  it("opens a try-on and deletes it after confirming", async () => {
    signInCustomer();
    setLocation("/account/try-on?request=VTR001");
    api.get("/try-on/eligibility", usage());
    api.get("/try-on/requests", page([request()]));
    api.get("/try-on/requests/VTR001", request());
    api.get("/try-on/requests/VTR001/image", { ok: true });
    api.delete("/try-on/requests/VTR001", { deleted: true, pending: false });
    const { user } = renderUI(<AccountTryOnView />);
    const dialog = await screen.findByRole("dialog", { name: "Linen Shirt" });
    expect(within(dialog).getByText("Kept until you delete it.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /delete/i }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this try-on?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.requests("DELETE", "/try-on/requests/VTR001")).toHaveLength(1));
  });

  it("sends a request for more access", async () => {
    signInCustomer();
    setLocation("/account/try-on?tab=access");
    api.get("/try-on/eligibility", usage());
    api.get("/try-on/access-requests", []);
    api.get("/try-on/allocations", []);
    api.post("/try-on/access-requests", { id: "VAR001", status: "pending" });
    const { user } = renderUI(<AccountTryOnView />);
    await user.type(await screen.findByLabelText(/why do you need it/i), "Wedding shopping this month");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => expect(api.last("POST", "/try-on/access-requests")?.body).toMatchObject({
      kind: "more_usage", reason: "Wedding shopping this month", expectedUsage: 10,
    }));
  });
});
