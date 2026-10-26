import { describe, expect, it } from "vitest";

import type { Credential } from "@/services/admin/tryOnAdminService";
import { api } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { signInAdminUser } from "@/test/sliceG1-admin";

import { AdminTryOnCredentialsView } from "./AdminTryOnCredentialsView";

const SECRET = "hf_SuperSecretToken1234567890";

function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "VCR001", providerId: "VPR001", label: "HF main", masked: "••••••••7890", status: "active", state: "healthy",
    hidden: false, autoSelect: true, priority: 100, scope: "shared", dedicatedCustomerId: null, modelIds: [], capabilityKeys: [],
    categoryIds: [], dailyLimit: null, monthlyLimit: null, validationStatus: "valid", lastValidatedAt: "2026-10-10T09:00:00",
    cooldownUntil: null, consecutiveFailures: 0, lastErrorCode: "", lastError: "", lastErrorAt: null, rateLimitInfo: null,
    successCount: 12, failureCount: 1, lastUsedAt: "2026-10-10T09:30:00", rotatedAt: null, deletedAt: null,
    createdAt: "2026-10-01T09:00:00", createdBy: "ADM001",
    ...overrides,
  };
}

const counts = { total: 1, hidden: 0, deleted: 0, active: 1, disabled: 0, invalid: 0, rate_limited: 0, unhealthy: 0, healthy: 1, unvalidated: 0, dedicated: 0 };
const encryption = { configured: true, usingFallback: false, available: true, previousKeySet: false };

function backend(items: Credential[] = [credential()]) {
  api.get("/admin/try-on/credentials", { items, counts, encryption });
  api.get("/admin/try-on/providers", [{ id: "VPR001", kind: "huggingface", name: "Hugging Face", enabled: true, timeoutSeconds: 120,
    maxRetries: 2, cooldownSeconds: 900, health: "healthy", healthDetail: "", lastCheckedAt: null }]);
  api.get("/admin/try-on/models", [{ id: "VMD001", providerId: "VPR001", name: "OOTDiffusion · half body", description: "",
    adapterKey: "huggingface.ootd_half_body", adapterLabel: "OOTD", adapterAvailable: true, config: {}, capabilities: ["garment.upper_body"],
    qualityTier: "standard", enabled: true, verified: true, priority: 10, avgSeconds: 40, costPerCall: null, costCurrency: "USD", routable: true }]);
  api.get("/admin/try-on/mappings", { items: [], categories: [{ id: "CAT001", name: "Women", slug: "women", subcategories: [] }] });
}

describe("AdminTryOnCredentialsView", () => {
  it("lists credentials by their mask and state — never a token", async () => {
    signInAdminUser();
    setLocation("/admin/try-on/credentials");
    backend([credential(), credential({ id: "VCR002", label: "HF spare", masked: "••••••••abcd", state: "rate_limited", status: "rate_limited",
      lastError: "This AI service is temporarily busy.", cooldownUntil: "2026-10-10T11:00:00" })]);
    renderUI(<AdminTryOnCredentialsView />);
    expect(await screen.findByText("HF main")).toBeInTheDocument();
    expect(screen.getByText("••••••••7890")).toBeInTheDocument();
    // The state filter offers the same words; the badges are the ones in the table.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Healthy")).toBeInTheDocument();
    expect(within(table).getByText("Rate limited")).toBeInTheDocument();
    expect(screen.getByText("This AI service is temporarily busy.")).toBeInTheDocument();
  });

  it("sends a new token once, then forgets it", async () => {
    signInAdminUser();
    setLocation("/admin/try-on/credentials");
    backend();
    api.post("/admin/try-on/credentials", credential({ id: "VCR003", label: "HF new" }));
    const { user } = renderUI(<AdminTryOnCredentialsView />);
    await user.click(await screen.findByRole("button", { name: /add credential/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add a credential" });
    const token = within(dialog).getByLabelText(/^Token/);
    expect(token).toHaveAttribute("type", "password");
    await user.type(within(dialog).getByLabelText(/^Name/), "HF new");
    await user.type(token, SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.last("POST", "/admin/try-on/credentials")?.body).toMatchObject({
      providerId: "VPR001", secret: SECRET, label: "HF new", scope: "shared", validateNow: true,
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a credential" })).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("adds several at once and reports skipped lines by number", async () => {
    signInAdminUser();
    setLocation("/admin/try-on/credentials");
    backend();
    api.post("/admin/try-on/credentials/bulk", { added: [credential({ id: "VCR004" })], skipped: [{ line: 2, reason: "already saved" }] });
    const { user } = renderUI(<AdminTryOnCredentialsView />);
    await user.click(await screen.findByRole("button", { name: /add several/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add several credentials" });
    await user.type(within(dialog).getByLabelText(/Tokens, one per line/), `${SECRET}{enter}${SECRET}`);
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("1 added.")).toBeInTheDocument();
    expect(within(dialog).getByText("Line 2: already saved")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("tells an administrator without the permission that it isn't theirs to see", async () => {
    signInAdminUser({ role: "manager", permissions: ["orders", "try-on"] });
    setLocation("/admin/try-on/credentials");
    backend();
    renderUI(<AdminTryOnCredentialsView />);
    expect(await screen.findByText(/You don.t have access to AI credentials/)).toBeInTheDocument();
    expect(api.requests("GET", "/admin/try-on/credentials")).toHaveLength(0);
  });

  it("deletes only after confirming", async () => {
    signInAdminUser();
    setLocation("/admin/try-on/credentials");
    backend();
    api.delete("/admin/try-on/credentials/VCR001", credential({ state: "deleted", masked: "", deletedAt: "2026-10-10T10:00:00" }));
    const { user } = renderUI(<AdminTryOnCredentialsView />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(api.requests("DELETE", "/admin/try-on/credentials/VCR001")).toHaveLength(0);
    const confirm = await screen.findByRole("dialog", { name: "Delete this credential?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.requests("DELETE", "/admin/try-on/credentials/VCR001")).toHaveLength(1));
  });
});
