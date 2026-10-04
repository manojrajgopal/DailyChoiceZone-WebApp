/**
 * The engagement and people lists find records by ID only (docs/id-lookup.md):
 * store credit, reward points, questions, the member directory and abandoned
 * carts. Typing an ID suggests IDs, a name finds nothing, and the chosen ID is
 * what the list's endpoint receives.
 */
import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { idPreview, lookupBackend, productPreview } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor } from "@/test/render";

import { AdminMembersDirectoryView } from "../AdminMembersDirectoryView";
import { AdminAbandonedCartsView } from "../operations/AdminAbandonedCartsView";
import { AdminLoyaltyView } from "./AdminLoyaltyView";
import { AdminQuestionsView } from "./AdminQuestionsView";
import { AdminStoreCreditView } from "./AdminStoreCreditView";

const PAGE = { page: 1, page_size: 25, total: 0, total_pages: 1 };
const empty = <T extends object>(extra?: T) => ({ items: [], pagination: PAGE, ...(extra ?? {}) });

function customerLookup() {
  lookupBackend("customer", [
    idPreview("customer", "CUS001", { title: "Asha Rao", subtitle: "asha@example.com" }),
    idPreview("customer", "CUS002", { title: "Ravi Kumar", subtitle: "ravi@example.com" }),
  ]);
}

const query = (path: string) => api.last("GET", path)!.query;

describe("AdminStoreCreditView — Customer ID", () => {
  it("suggests Customer IDs, finds nothing for a name, and filters by the picked ID", async () => {
    signIn("admin");
    setLocation("/admin/store-credit");
    api.get("/admin/store-credit", empty({ outstanding: 0 }));
    customerLookup();
    const { user } = renderUI(<AdminStoreCreditView />);

    const field = await screen.findByRole("combobox", { name: "Customer ID" });
    await user.type(field, "Asha");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "CUS00");
    expect(await screen.findByRole("option", { name: /CUS001/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /CUS002/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/store-credit?q=CUS002", { scroll: false });
  });

  it("sends the Customer ID as q", async () => {
    signIn("admin");
    setLocation("/admin/store-credit?q=CUS002");
    api.get("/admin/store-credit", empty({ outstanding: 0 }));
    renderUI(<AdminStoreCreditView />);
    expect(await screen.findByRole("group", { name: "Filtered by Customer ID CUS002" })).toBeInTheDocument();
    await waitFor(() => expect(query("/admin/store-credit").get("q")).toBe("CUS002"));
  });
});

describe("AdminLoyaltyView — Customer ID and Order ID", () => {
  it("balances: a name finds nothing; a picked Customer ID becomes the filter", async () => {
    signIn("admin");
    setLocation("/admin/loyalty");
    api.get("/admin/loyalty/balances", empty());
    customerLookup();
    const { user } = renderUI(<AdminLoyaltyView />);

    const field = await screen.findByRole("combobox", { name: "Customer ID" });
    await user.type(field, "asha@example.com");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "CUS");
    await user.click(await screen.findByRole("option", { name: /CUS001/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/loyalty?customer=CUS001", { scroll: false });
  });

  it("balances send the Customer ID as q", async () => {
    signIn("admin");
    setLocation("/admin/loyalty?customer=CUS001");
    api.get("/admin/loyalty/balances", empty());
    renderUI(<AdminLoyaltyView />);
    await waitFor(() => expect(query("/admin/loyalty/balances").get("q")).toBe("CUS001"));
  });

  it("the ledger sends customerId and orderId separately, never a free-text q", async () => {
    signIn("admin");
    setLocation("/admin/loyalty?tab=ledger&customer=CUS001&order=DCZ10241&kind=earn");
    api.get("/admin/loyalty/ledger", empty());
    renderUI(<AdminLoyaltyView />);

    expect(await screen.findByRole("group", { name: "Filtered by Order ID DCZ10241" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Filtered by Customer ID CUS001" })).toBeInTheDocument();
    await waitFor(() => expect(query("/admin/loyalty/ledger").get("orderId")).toBe("DCZ10241"));
    const sent = query("/admin/loyalty/ledger");
    expect(sent.get("customerId")).toBe("CUS001");
    expect(sent.get("kind")).toBe("earn");
    expect(sent.has("q")).toBe(false);
  });
});

describe("AdminQuestionsView — question words vs. IDs", () => {
  it("product and customer are picked by ID; a product name finds no product", async () => {
    signIn("admin");
    setLocation("/admin/questions");
    api.get("/admin/questions", empty({ counts: {} }));
    lookupBackend("product", [productPreview(), productPreview({ id: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002" })]);
    const { user } = renderUI(<AdminQuestionsView />);

    const field = await screen.findByRole("combobox", { name: "Product ID" });
    await user.type(field, "Kurta");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "PRD");
    await user.click(await screen.findByRole("option", { name: /PRD002/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/questions?product=PRD002", { scroll: false });
  });

  it("sends productId, customerId and the words separately", async () => {
    signIn("admin");
    setLocation("/admin/questions?product=PRD001&customer=CUS002&text=shrink");
    api.get("/admin/questions", empty({ counts: {} }));
    renderUI(<AdminQuestionsView />);

    await waitFor(() => expect(query("/admin/questions").get("productId")).toBe("PRD001"));
    const sent = query("/admin/questions");
    expect(sent.get("customerId")).toBe("CUS002");
    expect(sent.get("text")).toBe("shrink");
    expect(sent.has("q")).toBe(false);
    expect(screen.getByRole("searchbox", { name: "Words in the question" })).toHaveValue("shrink");
  });
});

describe("AdminMembersDirectoryView — Membership, Customer and plan IDs", () => {
  it("a plan is picked by its ID, not chosen by name", async () => {
    signIn("admin");
    setLocation("/admin/membership/members");
    api.get("/admin/memberships/search", empty({ counts: { active: 0, pending: 0, expired: 0, cancelled: 0 }, plans: [] }));
    lookupBackend("membership_plan", [idPreview("membership_plan", "MBP001", { title: "Quarterly" })]);
    const { user } = renderUI(<AdminMembersDirectoryView />);

    const field = await screen.findByRole("combobox", { name: "Membership plan ID" });
    await user.type(field, "Quarterly");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "MBP");
    await user.click(await screen.findByRole("option", { name: /MBP001/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/membership/members?plan=MBP001", { scroll: false });
  });

  it("sends the Membership ID, Customer ID and plan ID", async () => {
    signIn("admin");
    setLocation("/admin/membership/members?q=MEM001&customer=CUS001&plan=MBP001");
    api.get("/admin/memberships/search", empty({ counts: { active: 0, pending: 0, expired: 0, cancelled: 0 }, plans: [] }));
    renderUI(<AdminMembersDirectoryView />);

    await waitFor(() => expect(query("/admin/memberships/search").get("q")).toBe("MEM001"));
    const sent = query("/admin/memberships/search");
    expect(sent.get("customer")).toBe("CUS001");
    expect(sent.get("plan")).toBe("MBP001");
  });
});

describe("AdminAbandonedCartsView — Customer ID", () => {
  it("a name finds nothing; a picked Customer ID is sent as q", async () => {
    signIn("admin");
    setLocation("/admin/carts");
    api.get("/admin/carts/abandoned", empty());
    customerLookup();
    const { user } = renderUI(<AdminAbandonedCartsView />);

    const field = await screen.findByRole("combobox", { name: "Customer ID" });
    await user.type(field, "Ravi");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "CUS");
    await user.click(await screen.findByRole("option", { name: /CUS002/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/carts?q=CUS002", { scroll: false });
  });

  it("sends the Customer ID", async () => {
    signIn("admin");
    setLocation("/admin/carts?q=CUS002");
    api.get("/admin/carts/abandoned", empty());
    renderUI(<AdminAbandonedCartsView />);
    await waitFor(() => expect(query("/admin/carts/abandoned").get("q")).toBe("CUS002"));
  });
});
