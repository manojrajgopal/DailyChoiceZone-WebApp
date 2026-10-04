/**
 * "My support requests": the box finds a request by its request number or its
 * order number, exactly (docs/id-lookup.md). The server scopes every search to
 * the signed-in customer.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { api } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { deskRow } from "@/test/sliceH-desk-fixtures";
import type { TicketRow } from "@/services/supportService";

vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ isSignedIn: true }) }));
vi.mock("@/components/account/AccountShell", () => ({
  AccountShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { SupportTicketsView } from "./SupportTicketsView";

function row(overrides: Partial<TicketRow> = {}): TicketRow {
  const { customerName: _n, customerEmail: _e, customerId: _c, escalationLevel: _l, teamId: _t, agentId: _a, mergedInto: _m, ...base } =
    deskRow();
  void [_n, _e, _c, _l, _t, _a, _m];
  return { ...base, ...overrides };
}

const box = () => screen.getByRole("searchbox", { name: "Find a request by its request number or order number" });

describe("SupportTicketsView", () => {
  it("sends the request number when Enter is pressed, not on every keystroke", async () => {
    api.get("/support/tickets", (request) =>
      request.query.get("q") === "DCZ-2026-000101" ? [row()] : request.query.get("q") ? [] : [row(), row({ id: "T2", number: "DCZ-2026-000102" })],
    );
    const { user } = renderUI(<SupportTicketsView />);
    await screen.findByText("DCZ-2026-000102", { exact: false });
    const before = api.requests("GET", "/support/tickets").length;
    await user.type(box(), "DCZ-2026-000101");
    expect(api.requests("GET", "/support/tickets")).toHaveLength(before);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.last("GET", "/support/tickets")!.query.get("q")).toBe("DCZ-2026-000101"));
    await waitFor(() => expect(screen.queryByText("DCZ-2026-000102", { exact: false })).not.toBeInTheDocument());
  });

  it("says plainly when no request of theirs has that number", async () => {
    api.get("/support/tickets", (request) => (request.query.get("q") ? [] : [row()]));
    const { user } = renderUI(<SupportTicketsView />);
    await screen.findByText("DCZ-2026-000101", { exact: false });
    await user.type(box(), "Parcel{Enter}");
    expect(await screen.findByText("No requests match")).toBeInTheDocument();
    expect(screen.getByText(/No request of yours has the number Parcel/)).toBeInTheDocument();
  });

  it("shows every request again once the box is cleared", async () => {
    api.get("/support/tickets", (request) => (request.query.get("q") ? [] : [row()]));
    const { user } = renderUI(<SupportTicketsView />);
    await screen.findByText("DCZ-2026-000101", { exact: false });
    await user.type(box(), "DCZ10241{Enter}");
    await screen.findByText("No requests match");
    await user.clear(box());
    expect(await screen.findByText("DCZ-2026-000101", { exact: false })).toBeInTheDocument();
    expect(api.last("GET", "/support/tickets")!.query.get("q")).toBeNull();
  });
});
