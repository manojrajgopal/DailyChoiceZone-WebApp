import { beforeEach, describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { settingsResponse } from "@/test/segments-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminSegmentSettingsView, settingsProblems } from "./AdminSegmentSettingsView";

const toasts = () => useToastStore.getState().toasts.map((entry) => entry.message);

beforeEach(() => {
  api.get("/admin/segments/settings", settingsResponse());
});

async function renderSettings() {
  const view = renderUI(<AdminSegmentSettingsView />);
  await screen.findByRole("heading", { name: "RFM settings" });
  return view;
}

describe("AdminSegmentSettingsView", () => {
  it("explains a missing segments permission", async () => {
    api.get("/admin/segments/settings", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<AdminSegmentSettingsView />);
    expect(await screen.findByText("Your role doesn't include segments")).toBeInTheDocument();
  });

  it("shows the bands, the label map and how fresh the metrics are", async () => {
    await renderSettings();
    expect(screen.getByLabelText("Recency (days since the last order) threshold 1")).toHaveValue(30);
    expect(screen.getByLabelText("Frequency (orders kept) threshold 4")).toHaveValue(8);
    expect(screen.getByLabelText("Monetary (net spend) threshold 4")).toHaveValue(15000);
    expect(screen.getByLabelText(/Refresh everyone every/)).toHaveValue(6);
    expect(screen.getByLabelText("Label for champions")).toHaveValue("Champions");
    expect(screen.getByLabelText("champions R min")).toHaveValue("4");
    expect(screen.getByLabelText("lost R max")).toHaveValue("1");

    const status = screen.getByLabelText("Metrics status");
    expect(status).toHaveTextContent("1,200");
    expect(status).toHaveTextContent("1,180");
    expect(status).toHaveTextContent("20");
    // Nothing changed yet, so nothing to save.
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("saves the edited settings in the API's shape", async () => {
    const saved = settingsResponse();
    saved.settings.refreshHours = 12;
    saved.status.dirty = 0;
    api.put("/admin/segments/settings", saved);
    const { user } = await renderSettings();

    await user.clear(screen.getByLabelText(/Refresh everyone every/));
    await user.type(screen.getByLabelText(/Refresh everyone every/), "12");
    await user.clear(screen.getByLabelText("Label for loyal"));
    await user.type(screen.getByLabelText("Label for loyal"), " Regulars ");
    await user.selectOptions(screen.getByLabelText("loyal M min"), "2");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(api.last("PUT", "/admin/segments/settings")).toBeTruthy());
    const body = api.last("PUT", "/admin/segments/settings")!.body;
    expect(body.refreshHours).toBe(12);
    expect(body.labels[1]).toEqual({ key: "loyal", label: "Regulars", r: [3, 5], f: [3, 5], m: [2, 5] });
    expect(body.recencyDays).toEqual([30, 60, 90, 180]);
    await waitFor(() => expect(toasts()).toContain("RFM settings saved. Customers are re-scored and active segments recalculated."));
  });

  it("catches bands that don't increase and ranges upside down before saving", async () => {
    const { user } = await renderSettings();
    const second = screen.getByLabelText("Recency (days since the last order) threshold 2");
    await user.clear(second);
    await user.type(second, "20");
    await user.selectOptions(screen.getByLabelText("champions F min"), "5");
    await user.selectOptions(screen.getByLabelText("champions F max"), "4");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByText("Each number must be bigger than the one before it.")).toBeInTheDocument();
    expect(screen.getByText("Each minimum must be at most its maximum.")).toBeInTheDocument();
    expect(api.last("PUT", "/admin/segments/settings")).toBeUndefined();
  });

  it("shows the server's explanation when it refuses the settings", async () => {
    api.put("/admin/segments/settings", fail(422, "Monetary bands: use four increasing amounts.", "INVALID_SEGMENT_SETTINGS"));
    const { user } = await renderSettings();
    await user.clear(screen.getByLabelText(/Refresh everyone every/));
    await user.type(screen.getByLabelText(/Refresh everyone every/), "8");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Monetary bands: use four increasing amounts.")).toBeInTheDocument();
  });

  it("validates every rule the server applies", () => {
    const ok = settingsResponse().settings;
    expect(settingsProblems(ok)).toEqual({});
    expect(settingsProblems({ ...ok, refreshHours: 49 })).toHaveProperty("refreshHours");
    expect(settingsProblems({ ...ok, monetaryRupees: [0, 1, 2, 3] })).toEqual({ monetaryRupees: "Use numbers above zero." });
    expect(settingsProblems({ ...ok, frequencyOrders: [1, 2, Number.NaN, 4] })).toEqual({ frequencyOrders: "Enter all four numbers." });
    expect(settingsProblems({ ...ok, labels: [{ ...ok.labels[0]!, label: "  " }] })).toEqual({ "labels.0": "Give the label a name." });
  });
});
