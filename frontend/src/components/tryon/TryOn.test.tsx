import { describe, expect, it } from "vitest";

import type { Product } from "@/types";
import type { TryOnCatalogue, TryOnEligibility, TryOnOffer, TryOnRequest } from "@/services/tryOnService";
import { tryOnFor } from "@/services/tryOnService";
import { api, fail, file } from "@/test/api";
import { fireEvent, renderUI, screen, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";
import { signInCustomer } from "@/test/sliceD-acct3-session";

import { TryOnBadge, TryOnButton } from "./TryOnButton";

const product = {
  id: "PRD002", name: "Linen Shirt", category: "women", subcategory: "tops",
  colors: [{ name: "Blue", hex: "#00f" }], sizes: ["S", "M"],
} as unknown as Product;

function catalogue(overrides: Partial<TryOnCatalogue> = {}): TryOnCatalogue {
  return {
    enabled: true,
    storage: "ephemeral",
    capabilities: [
      { key: "garment.upper_body", name: "Tops, shirts and jackets", family: "garment", description: "", subjectKind: "half_body", state: "available" },
      { key: "wrist.watch", name: "Watches", family: "wrist", description: "", subjectKind: "wrist", state: "coming_soon" },
      { key: "garment.dress", name: "Dresses", family: "garment", description: "", subjectKind: "full_body", state: "unsupported" },
    ],
    mappings: [{ category: "women", subcategory: "", capability: "garment.upper_body" }],
    productOverrides: {},
    ...overrides,
  };
}

function eligibility(overrides: Partial<TryOnEligibility> = {}): TryOnEligibility {
  return {
    eligible: true, reason: "", source: "plan", planId: "MBP001", planName: "Prime", perPeriod: 10, usedThisPeriod: 2,
    remaining: 8, perDay: null, usedToday: 0, resetsAt: "2026-11-01T00:00:00", concurrent: 1, inProgress: 0, capabilities: [],
    maxUploadMb: 8, retention: "ephemeral", retentionDays: 7, ephemeralMinutes: 30, storageQuota: null, storedResults: 0,
    download: true, history: true, retriesPerRequest: 2, allocationRequests: true, modelChoice: false, allocations: [], trial: null,
    ...overrides,
  };
}

function offer(overrides: Partial<TryOnOffer> = {}): TryOnOffer {
  return {
    productId: "PRD002", productName: "Linen Shirt", state: "available", reason: "category",
    capability: { key: "garment.upper_body", name: "Tops, shirts and jackets", subjectKind: "half_body", guidance: ["Stand facing the camera."], inputRules: {} },
    eligibility: eligibility(), models: [], avgSeconds: 40, privacyNotice: "Your photo stays private.",
    storage: { mode: "ephemeral", ephemeralMinutes: 30 }, feedback: true,
    ...overrides,
  };
}

function request(overrides: Partial<TryOnRequest> = {}): TryOnRequest {
  return {
    id: "VTR001", status: "queued", product: { id: "PRD002", name: "Linen Shirt", image: null }, color: "Blue", size: "M",
    capability: { key: "garment.upper_body", name: "Tops" }, model: null, queuePosition: 1, etaSeconds: 40, error: null,
    canRetry: false, canCancel: true,
    result: { available: false, mode: "ephemeral", expiresAt: null, downloadable: true, deleted: false },
    original: { available: true }, favourite: false, feedback: null, createdAt: "2026-10-10T10:00:00", startedAt: null,
    finishedAt: null, durationMs: null,
    ...overrides,
  };
}

describe("tryOnFor — which products can be tried on", () => {
  it("follows the category mapping, a subcategory's own mapping first, and a product's own choice above both", () => {
    const c = catalogue({
      mappings: [
        { category: "women", subcategory: "", capability: "garment.upper_body" },
        { category: "women", subcategory: "dresses", capability: "garment.dress" },
      ],
      productOverrides: { PRD009: null, PRD010: "wrist.watch" },
    });
    expect(tryOnFor({ id: "P1", category: "women", subcategory: "tops" }, c).state).toBe("available");
    expect(tryOnFor({ id: "P2", category: "women", subcategory: "dresses" }, c).state).toBe("unsupported");
    expect(tryOnFor({ id: "PRD009", category: "women", subcategory: "tops" }, c).state).toBe("unsupported");
    expect(tryOnFor({ id: "PRD010", category: "women", subcategory: "tops" }, c).state).toBe("coming_soon");
    expect(tryOnFor({ id: "P3", category: "home", subcategory: "" }, c).state).toBe("unsupported");
    expect(tryOnFor({ id: "P1", category: "women", subcategory: "tops" }, { ...c, enabled: false }).state).toBe("off");
  });
});

describe("TryOnButton", () => {
  it("shows nothing for an item that can't be tried on", async () => {
    api.get("/try-on/catalogue", catalogue({ mappings: [] }));
    renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await waitFor(() => expect(api.requests("GET", "/try-on/catalogue")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /try it on/i })).not.toBeInTheDocument();
  });

  it("says coming soon instead of offering a try-on it can't do", async () => {
    api.get("/try-on/catalogue", catalogue({ mappings: [{ category: "women", subcategory: "", capability: "wrist.watch" }] }));
    renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    expect(await screen.findByText(/watches is coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try it on/i })).not.toBeInTheDocument();
  });

  it("sends a shopper whose plan doesn't include it to the memberships", async () => {
    signInCustomer();
    api.get("/try-on/catalogue", catalogue());
    api.get("/try-on/products/PRD002", offer({ eligibility: eligibility({ eligible: false, reason: "plan_ineligible" }) }));
    const { user } = renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await user.click(await screen.findByRole("button", { name: /try it on/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("A membership benefit")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "See memberships" })).toHaveAttribute("href", "/membership");
  });

  it("refuses a file that isn't a photo before sending anything", async () => {
    signInCustomer();
    api.get("/try-on/catalogue", catalogue());
    api.get("/try-on/products/PRD002", offer());
    api.get("/try-on/photos", []);
    const { user } = renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await user.click(await screen.findByRole("button", { name: /try it on/i }));
    const input = await screen.findByLabelText("Choose a photo of yourself");
    // The picker's own filter would hide a PDF; a dropped or forced file still reaches the check.
    fireEvent.change(input, { target: { files: [new File(["%PDF"], "cv.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("Please choose a JPEG, PNG or WebP photo.")).toBeInTheDocument();
    expect(api.requests("POST", "/try-on/photos")).toHaveLength(0);
  });

  it("uploads a photo, starts the try-on once with a request key, follows it and shows the result", async () => {
    signInCustomer();
    api.get("/try-on/catalogue", catalogue());
    api.get("/try-on/products/PRD002", offer());
    api.get("/try-on/photos", []);
    api.post("/try-on/photos", { id: "VPH001", width: 600, height: 800, saved: false, storage: "ephemeral", expiresAt: null, createdAt: "2026-10-10T10:00:00" });
    api.post("/try-on/requests", request());
    api.get("/try-on/requests/VTR001", request({ status: "succeeded", queuePosition: null, etaSeconds: null, canCancel: false,
      result: { available: true, mode: "ephemeral", expiresAt: "2026-10-10T10:30:00", downloadable: true, deleted: false } }));
    api.get("/try-on/requests/VTR001/image", file("jpeg-bytes", { "content-type": "image/jpeg" }));

    const { user } = renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await user.click(await screen.findByRole("button", { name: /try it on/i }));
    expect(await screen.findByText("Stand facing the camera.")).toBeInTheDocument();
    expect(screen.getByText(/8 of 10 try-ons left/)).toBeInTheDocument();
    expect(screen.getByText(/Your photo stays private/)).toBeInTheDocument();

    await user.upload(screen.getByLabelText("Choose a photo of yourself"), new File(["img"], "me.jpg", { type: "image/jpeg" }));
    expect(await screen.findByText("Photo ready")).toBeInTheDocument();
    expect(api.last("POST", "/try-on/photos")!.body).toBeInstanceOf(FormData);

    await user.click(screen.getByRole("button", { name: /^try it on$/i }));
    const started = api.last("POST", "/try-on/requests")!;
    expect(started.body).toEqual({ productId: "PRD002", photoId: "VPH001", color: "Blue", size: "M", modelId: null });
    expect(started.headers["idempotency-key"]).toMatch(/^tryon-/);

    expect(await screen.findByRole("slider", { name: /compare your photo/i }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/Not saved — download it/)).toBeInTheDocument();
    expect(api.requests("POST", "/try-on/requests")).toHaveLength(1);
  });

  it("explains a failure in plain words and offers a retry when allowed", async () => {
    signInCustomer();
    api.get("/try-on/catalogue", catalogue());
    api.get("/try-on/products/PRD002", offer());
    api.get("/try-on/photos", [{ id: "VPH009", width: 600, height: 800, saved: true, storage: "s3", expiresAt: null, createdAt: "2026-10-01T10:00:00" }]);
    api.post("/try-on/requests", request({ status: "failed", canRetry: true, canCancel: false,
      error: { code: "rate_limited", message: "The try-on service is busy right now. Please try again in a few minutes.", retryable: true } }));
    const { user } = renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await user.click(await screen.findByRole("button", { name: /try it on/i }));
    await user.click(await screen.findByRole("button", { name: /Photo 1/ }));
    await user.click(screen.getByRole("button", { name: /^try it on$/i }));
    expect(await screen.findByText("The try-on service is busy right now. Please try again in a few minutes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("shows the server's refusal when starting is refused", async () => {
    signInCustomer();
    api.get("/try-on/catalogue", catalogue());
    api.get("/try-on/products/PRD002", offer());
    api.get("/try-on/photos", [{ id: "VPH009", width: 600, height: 800, saved: true, storage: "s3", expiresAt: null, createdAt: "2026-10-01T10:00:00" }]);
    api.post("/try-on/requests", fail(429, "You've reached your virtual try-on limit.", "TRY_ON_LIMIT_REACHED"));
    const { user } = renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await user.click(await screen.findByRole("button", { name: /try it on/i }));
    await user.click(await screen.findByRole("button", { name: /Photo 1/ }));
    await user.click(screen.getByRole("button", { name: /^try it on$/i }));
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.message)).toContain("You've reached your virtual try-on limit."));
    // Still on the photo step, ready to try again later.
    expect(screen.getByRole("button", { name: /^try it on$/i })).toBeEnabled();
  });
});

describe("TryOnBadge", () => {
  it("badges only products that can be tried on", async () => {
    api.get("/try-on/catalogue", catalogue());
    renderUI(
      <>
        <TryOnBadge product={product} />
        <TryOnBadge product={{ id: "PRD003", category: "electronics", subcategory: "audio" }} />
      </>,
    );
    expect(await screen.findAllByText("Try on")).toHaveLength(1);
    // One shared request however many cards ask.
    expect(api.requests("GET", "/try-on/catalogue")).toHaveLength(1);
  });
});

describe("TryOnButton — signed out", () => {
  it("sends the shopper to sign in and back to this product", async () => {
    api.get("/try-on/catalogue", catalogue());
    api.get("/try-on/products/PRD002", offer({ eligibility: null }));
    window.history.pushState({}, "", "/product/PRD002?color=Blue");
    const { user } = renderUI(<TryOnButton product={product} color="Blue" size="M" />);
    await user.click(await screen.findByRole("button", { name: /try it on/i }));
    const link = await screen.findByRole("link", { name: "Sign in" });
    expect(link).toHaveAttribute("href", "/account?next=%2Fproduct%2FPRD002%3Fcolor%3DBlue");
  });
});
