import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";

import { DashboardOperations } from "./DashboardOperations";

const PACKING = { waitingToPick: 4, waitingToPack: 2, packedToday: 9, overdue: 1, slaHours: 24, labelsPending: 3,
  labelsGeneratedToday: 5, labelFailures: 0 };
const REFUNDS = { requested: 2, awaitingApproval: 1, processing: 0, failed: 0, refundedToday: 124900,
  refundedTodayCount: 1 };

function forbidden(path: string) {
  api.get(path, fail(403, "Forbidden", "PERMISSION_DENIED"));
}

describe("DashboardOperations", () => {
  it("shows each module the role can read, with links and alerts", async () => {
    api.get("/admin/packing/summary", PACKING);
    api.get("/admin/refunds/summary", REFUNDS);
    forbidden("/admin/segments/summary");
    forbidden("/admin/search/analytics");
    forbidden("/admin/auth/methods");
    renderUI(<DashboardOperations />);
    const packing = await screen.findByRole("region", { name: "Packing & labels" });
    expect(packing).toHaveTextContent("Waiting to pick4");
    // Overdue jobs link to the overdue queue and are flagged.
    const overdue = within(packing).getByText("Overdue").nextElementSibling!.querySelector("a")!;
    expect(overdue).toHaveAttribute("href", "/admin/packing?overdue=1");
    expect(overdue).toHaveClass("text-[#a12b2b]");
    expect(await screen.findByRole("region", { name: "Refunds" })).toHaveTextContent("Refunded today₹1,249");
    expect(screen.queryByRole("region", { name: "Customers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sign-ins today" })).not.toBeInTheDocument();
  });

  it("renders nothing when the role can read none of them", async () => {
    for (const path of ["/admin/packing/summary", "/admin/refunds/summary", "/admin/segments/summary",
      "/admin/search/analytics", "/admin/auth/methods"]) forbidden(path);
    const { container } = renderUI(<DashboardOperations />);
    await waitFor(() => expect(api.requests().length).toBeGreaterThanOrEqual(5));
    expect(container).toBeEmptyDOMElement();
  });
});
