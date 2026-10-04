/**
 * The email history and the audit log identify records by ID
 * (docs/id-lookup.md): the record an email was about by its order or request
 * number, and who did something by their Admin user ID — never by a name or an
 * email address.
 */
import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor } from "@/test/render";

import { AdminEmailHistoryView } from "./AdminEmailHistoryView";
import { AdminAuditLogView } from "./growth/AdminAuditLogView";

const noMatch = async () => expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
const pagination = { page: 1, page_size: 25, total: 1, total_pages: 1 };

/* ----------------------------------------------------------- email history */

function serveEmails(href = "/admin/settings/email/history") {
  signIn("admin", "adm");
  setLocation(href);
  api.get("/admin/email/log/search", {
    items: [
      { id: 1, type: "order_updates", recipient: "asha@example.com", subject: "Your order has shipped", status: "sent", reference: "DCZ10241", at: "2026-10-02T06:00:00" },
    ],
    pagination,
    counts: { sent: 1, failed: 0 },
    types: [{ key: "order_updates", label: "Order updates" }],
  });
  lookupBackend("order", [idPreview("order", "DCZ10241")]);
  lookupBackend("ticket", [idPreview("ticket", "DCZ-2026-000101")]);
}

describe("AdminEmailHistoryView", () => {
  it("finds emails about an order by its Order ID, picked from the suggestions", async () => {
    serveEmails();
    const { user } = renderUI(<AdminEmailHistoryView />);
    await screen.findByText("Your order has shipped");
    await user.type(screen.getByRole("combobox", { name: "Order ID" }), "DCZ102");
    await user.click(await screen.findByRole("option", { name: "DCZ10241" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/settings/email/history?q=DCZ10241", { scroll: false });
  });

  it("finds emails about a support request by its number", async () => {
    serveEmails();
    const { user } = renderUI(<AdminEmailHistoryView />);
    await screen.findByText("Your order has shipped");
    await user.selectOptions(screen.getByRole("combobox", { name: "Which ID to find by" }), "ticket");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/settings/email/history?refKind=ticket", { scroll: false });
  });

  it("never finds an email by the recipient's address or name", async () => {
    serveEmails();
    const { user } = renderUI(<AdminEmailHistoryView />);
    await screen.findByText("Your order has shipped");
    await user.type(screen.getByRole("combobox", { name: "Order ID" }), "Asha");
    await noMatch();
    expect(screen.queryByRole("option", { name: /DCZ/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/recipient/i)).not.toBeInTheDocument();
  });

  it("sends the reference and the subject words as separate filters", async () => {
    serveEmails("/admin/settings/email/history?q=DCZ10241&subject=shipped");
    renderUI(<AdminEmailHistoryView />);
    await screen.findByText("Your order has shipped");
    const query = api.last("GET", "/admin/email/log/search")!.query;
    expect(query.get("q")).toBe("DCZ10241");
    expect(query.get("subject")).toBe("shipped");
    expect(screen.getByRole("group", { name: "Filtered by Order ID DCZ10241" })).toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------- audit log */

function serveAudit(href = "/admin/audit-logs") {
  signIn("admin", "adm");
  setLocation(href);
  api.get("/admin/audit-logs", {
    items: [
      {
        id: 1, occurredAt: "2026-10-02T06:00:00", action: "products.update", resourceType: "products", resourceId: "PRD001",
        summary: "Changed product Cotton Kurta", outcome: "success", statusCode: null, errorCode: "",
        actor: { type: "admin", id: "ADM001", name: "Manoj Rajan", email: "manoj@example.com", role: "super-admin" },
        ipAddress: "", hasChanges: true,
      },
    ],
    pagination,
    counts: { success: 1, failure: 0, denied: 0 },
  });
  api.get("/admin/audit-logs/facets", { resourceTypes: ["products"], actors: [{ id: "ADM001", name: "Manoj Rajan" }] });
  lookupBackend("admin_user", [idPreview("admin_user", "ADM001", { title: "Manoj Rajan" })]);
}

describe("AdminAuditLogView", () => {
  it("picks who did it by Admin user ID and sends that ID", async () => {
    serveAudit();
    const { user } = renderUI(<AdminAuditLogView />);
    await screen.findByText("Changed product Cotton Kurta");
    await user.type(screen.getByRole("combobox", { name: "Who (Admin user ID)" }), "ADM0");
    await user.click(await screen.findByRole("option", { name: "ADM001" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/audit-logs?actor=ADM001", { scroll: false });
  });

  it("never finds the actor by name or email, and offers no name list", async () => {
    serveAudit();
    const { user } = renderUI(<AdminAuditLogView />);
    await screen.findByText("Changed product Cotton Kurta");
    expect(screen.queryByRole("option", { name: "Manoj Rajan" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Who (Admin user ID)" }), "manoj@example.com");
    await noMatch();
    expect(screen.queryByRole("option", { name: "ADM001" })).not.toBeInTheDocument();
  });

  it("sends the actor and the record ID from the address bar as they are", async () => {
    serveAudit("/admin/audit-logs?actor=ADM001&q=PRD001");
    renderUI(<AdminAuditLogView />);
    await screen.findByText("Changed product Cotton Kurta");
    await waitFor(() => expect(api.last("GET", "/admin/audit-logs")).toBeTruthy());
    const query = api.last("GET", "/admin/audit-logs")!.query;
    expect(query.get("actor")).toBe("ADM001");
    expect(query.get("q")).toBe("PRD001");
    expect(screen.getByRole("group", { name: "Filtered by Who (Admin user ID) ADM001" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Record ID or action" })).toHaveValue("PRD001");
  });
});
