/**
 * The support desk finds and assigns records by ID (docs/id-lookup.md): a
 * ticket by its number, a customer by Customer ID, an order by Order ID and an
 * agent by support agent ID — never by a name or an email.
 */
import { describe, expect, it, vi } from "vitest";

import { api, ok } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { deskLookups, deskRow, deskTicket, serveSupportMe, supportDashboard } from "@/test/sliceH-desk-fixtures";
import { agent, supportConfig } from "@/test/sliceH-support-config";

import { AdminSupportDeskView } from "./AdminSupportDeskView";
import { AdminTicketDetailView } from "./AdminTicketDetailView";
import { StaffSettings } from "./settings/StaffSettings";

const noMatch = async () => expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);

function serveAgents() {
  lookupBackend("support_agent", [
    idPreview("support_agent", "7", { title: "Meera Iyer" }),
    idPreview("support_agent", "8", { title: "Ravi Kumar" }),
    idPreview("support_agent", "9", { title: "Sana Ali" }),
  ]);
}

/* -------------------------------------------------------------- the desk */

function serveDesk(href = "/admin/support") {
  signIn("admin", "adm");
  setLocation(href);
  serveSupportMe();
  api.get("/admin/support/lookups", deskLookups());
  api.get("/admin/support/dashboard", supportDashboard());
  api.get("/admin/support/tickets", ok([deskRow()], { total: 1 }));
  lookupBackend("ticket", [idPreview("ticket", "DCZ-2026-000101", { title: "Parcel not arrived" })]);
  lookupBackend("customer", [idPreview("customer", "CUS001", { title: "Anil Shah" })]);
  lookupBackend("order", [idPreview("order", "DCZ10241")]);
  serveAgents();
}

async function openDesk(href?: string) {
  serveDesk(href);
  const view = renderUI(<AdminSupportDeskView />);
  await screen.findByRole("combobox", { name: "Assignment" });
  return view;
}

describe("AdminSupportDeskView", () => {
  it("finds a ticket by its number, picked from the ID suggestions", async () => {
    const { user } = await openDesk();
    await user.type(screen.getByRole("combobox", { name: "Support ticket ID" }), "DCZ-2026-0001");
    await user.click(await screen.findByRole("option", { name: "DCZ-2026-000101" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/support?view=open&q=DCZ-2026-000101", { scroll: false });
    expect(api.last("GET", "/admin/lookup/ticket")!.query.get("q")).toBe("DCZ-2026-0001");
  });

  it("never finds a ticket by a customer's name or email", async () => {
    const { user } = await openDesk();
    await user.type(screen.getByRole("combobox", { name: "Support ticket ID" }), "Anil Shah");
    await noMatch();
    expect(screen.queryByRole("option", { name: /DCZ/ })).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("filters by support agent ID, never by the agent's name", async () => {
    const { user } = await openDesk();
    const box = screen.getByRole("combobox", { name: "Support agent ID" });
    await user.type(box, "Ravi");
    await noMatch();
    await user.clear(box);
    await user.type(box, "8");
    await user.click(await screen.findByRole("option", { name: "8" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/support?view=open&agent=8", { scroll: false });
  });

  it("sends the ID filters from the address bar exactly, and shows each as a chip", async () => {
    const { user } = await openDesk("/admin/support?view=all&q=DCZ-2026-000101&customer=CUS001&order=DCZ10241&agent=8&subject=parcel");
    await waitFor(() => expect(api.last("GET", "/admin/support/tickets")).toBeTruthy());
    const query = api.last("GET", "/admin/support/tickets")!.query;
    expect(query.get("q")).toBe("DCZ-2026-000101");
    expect(query.get("customer")).toBe("CUS001");
    expect(query.get("order")).toBe("DCZ10241");
    expect(query.get("agent")).toBe("8");
    expect(query.get("subject")).toBe("parcel");
    expect(screen.getByRole("group", { name: "Filtered by Support agent ID 8" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.getByRole("group", { name: "Filtered by Customer ID CUS001" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Filtered by Order ID DCZ10241" })).toBeInTheDocument();
  });

  it("picks the Customer ID to filter by from the suggestions", async () => {
    const { user } = await openDesk();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const box = screen.getByRole("combobox", { name: "Customer ID" });
    await user.type(box, "anil@example.com");
    await noMatch();
    await user.clear(box);
    await user.type(box, "CUS0");
    await user.click(await screen.findByRole("option", { name: "CUS001" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/support?view=open&customer=CUS001", { scroll: false });
  });

  it("keeps words in the subject as a separate content search", async () => {
    const { user } = await openDesk();
    await user.type(screen.getByRole("searchbox", { name: "Words in the subject" }), "parcel");
    // Applied a moment after typing stops.
    await waitFor(
      () => expect(router.replace).toHaveBeenLastCalledWith("/admin/support?view=open&subject=parcel", { scroll: false }),
      { timeout: 3000 },
    );
  });

  it("keeps 'Me' and 'Unassigned' as choices", async () => {
    const { user } = await openDesk();
    await user.selectOptions(screen.getByRole("combobox", { name: "Assignment" }), "unassigned");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/support?view=open&agent=unassigned", { scroll: false });
  });
});

/* ------------------------------------------------------------ one ticket */

async function openTicket(ticket = deskTicket()) {
  signIn("admin", "adm");
  setLocation(`/admin/support/ticket?id=${ticket.id}`);
  serveSupportMe();
  api.get("/admin/support/lookups", deskLookups());
  api.get(`/admin/support/tickets/${ticket.id}`, ticket);
  api.post(`/admin/support/tickets/${ticket.id}/read`, {});
  serveAgents();
  const view = renderUI(<AdminTicketDetailView />);
  await screen.findByRole("link", { name: /Other requests|Back/ }).catch(() => undefined);
  await screen.findAllByText(/DCZ-2026-000101/);
  await screen.findByText("Anil Shah", { selector: "p" });
  return view;
}

describe("AdminTicketDetailView", () => {
  it("assigns by support agent ID, sending the numeric ID and the agent's team", async () => {
    const { user } = await openTicket(deskTicket({ teamId: 1, agentId: 7 }));
    api.put("/admin/support/tickets/T1/assignment", deskTicket({ teamId: 2, agentId: 9 }));
    await user.click(screen.getByRole("button", { name: "Change Support agent ID" }));
    const box = screen.getByRole("combobox", { name: "Support agent ID" });
    await user.type(box, "9");
    await user.click(await screen.findByRole("option", { name: "9" }));
    await user.click(await screen.findByRole("button", { name: "Reassign" }));
    await waitFor(() =>
      expect(api.last("PUT", "/admin/support/tickets/T1/assignment")?.body).toEqual({ teamId: 2, agentId: 9 }),
    );
  });

  it("never finds an agent by name", async () => {
    const { user } = await openTicket(deskTicket({ agentId: null, agent: "" }));
    await user.type(screen.getByRole("combobox", { name: "Support agent ID" }), "Meera");
    await noMatch();
    expect(screen.queryByRole("option", { name: /^\d+$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Assign|Reassign)$/ })).not.toBeInTheDocument();
  });

  it("links to the customer's other requests by Customer ID, never by email", async () => {
    await openTicket(deskTicket({ customer: { ...deskTicket().customer, id: "CUS001" } }));
    const link = screen.getByRole("link", { name: "Other requests from this customer" });
    expect(link).toHaveAttribute("href", "/admin/support?view=all&customer=CUS001");
  });

  it("offers no 'other requests' link for a guest, who has no Customer ID", async () => {
    await openTicket(deskTicket({ customer: { ...deskTicket().customer, id: null } as never }));
    expect(screen.queryByRole("link", { name: "Other requests from this customer" })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------ staff list */

describe("StaffSettings", () => {
  const config = () =>
    supportConfig({
      agents: [
        agent({ id: 5, name: "Ravi Kumar", email: "ravi@example.com" }),
        agent({ id: 6, name: "Asha Rao", email: "asha@example.com" }),
      ],
    });

  function serve() {
    lookupBackend("support_agent", [
      idPreview("support_agent", "5", { title: "Ravi Kumar" }),
      idPreview("support_agent", "6", { title: "Asha Rao" }),
    ]);
    lookupBackend("admin_user", [idPreview("admin_user", "ADM004", { title: "Asha Rao" })]);
  }

  it("narrows the list to one support agent ID", async () => {
    serve();
    const { user } = renderUI(<StaffSettings config={config()} reload={vi.fn(async () => undefined)} />);
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Support agent ID" }), "5");
    await user.click(await screen.findByRole("option", { name: "5" }));
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    expect(screen.queryByText("Asha Rao")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Support agent ID filter" }));
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
  });

  it("never narrows by a name or an email", async () => {
    serve();
    const { user } = renderUI(<StaffSettings config={config()} reload={vi.fn(async () => undefined)} />);
    await user.type(screen.getByRole("combobox", { name: "Support agent ID" }), "Asha");
    await noMatch();
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
  });

  it("links a portal account by its Admin user ID", async () => {
    serve();
    api.put("/admin/support/config/agents/6", {});
    const reload = vi.fn(async () => undefined);
    const { user } = renderUI(<StaffSettings config={config()} reload={reload} />);
    await user.click(screen.getByRole("button", { name: "Edit Asha Rao" }));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("combobox", { name: "Portal account (Admin user ID)" });
    await user.type(box, "Asha");
    await noMatch();
    await user.clear(box);
    await user.type(box, "ADM0");
    await user.click(await within(dialog).findByRole("option", { name: "ADM004" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.last("PUT", "/admin/support/config/agents/6")?.body.adminUserId).toBe("ADM004"));
  });
});
