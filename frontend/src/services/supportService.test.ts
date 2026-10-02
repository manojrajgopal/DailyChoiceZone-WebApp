import { describe, expect, it } from "vitest";

import { ApiError } from "@/services/api/client";
import { api, fail, ok } from "@/test/api";

import {
  closeMyTicket,
  createTicket,
  customerAttachmentLink,
  deleteConfigRow,
  deskAttachmentLink,
  escalateDeskTicket,
  findDuplicates,
  getArticle,
  getDeskLookups,
  getDeskTicket,
  getHandlers,
  getMyTicket,
  getSupportConfig,
  getSupportConfiguration,
  getSupportDashboard,
  getSupportMe,
  linkDeskTicket,
  listDeskTickets,
  listMyNotifications,
  listMyTickets,
  markDeskRead,
  markMyNotificationsRead,
  markTicketRead,
  mergeDeskTicket,
  postDeskMessage,
  previewEmailTemplate,
  rateArticle,
  rateMyTicket,
  reason,
  replyToTicket,
  reopenMyTicket,
  saveConfigRow,
  saveEmailTemplate,
  saveSupportSettings,
  searchArticles,
  sendDeskTyping,
  sendTyping,
  setDeskAssignment,
  setDeskPriority,
  setDeskStage,
  setDeskStatus,
  startChat,
  unlinkDeskTicket,
} from "./supportService";

function formField(form: unknown, key: string): unknown {
  return form instanceof FormData ? form.get(key) : undefined;
}

describe("public support content", () => {
  it("getSupportConfig / getHandlers / getArticle GET without auth", async () => {
    api.get("/support/config", { categories: [], chat: { available: true, reason: "", hours: "" }, hours: "", open: true, attachments: { enabled: true, maxFiles: 5, maxSizeMb: 10, maxVideoSizeMb: 50 }, reopenDays: 7, responseTargets: { low: 48, medium: 24, high: 8, urgent: 2 } });
    await getSupportConfig();
    expect(api.last()!.headers.authorization).toBeUndefined();

    api.get("/support/categories/1/handlers", { choice: "team", teams: [] });
    await getHandlers(1);
    expect(api.requests("GET", "/support/categories/1/handlers")).toHaveLength(1);

    api.get("/support/articles/returns", { id: 1, title: "Returns", slug: "returns", summary: "", categoryIds: [], keywords: "", active: true, views: 0, helpful: 0, notHelpful: 0, sortOrder: 0, updatedAt: "" });
    expect((await getArticle("returns")).slug).toBe("returns");
  });

  it("searchArticles sends q and categories as query params", async () => {
    api.get(/\/support\/articles/, ok([]));
    await searchArticles("refund", [1, 2]);
    const request = api.last()!;
    expect(request.query.get("q")).toBe("refund");
    expect(request.query.get("categories")).toBe("1,2");
  });

  it("searchArticles omits categories when not given", async () => {
    api.get(/\/support\/articles/, ok([]));
    await searchArticles("refund");
    expect(api.last()!.query.has("categories")).toBe(false);
  });

  it("rateArticle POSTs helpful true/false", async () => {
    api.post("/support/articles/1/feedback", {});
    await rateArticle(1, true);
    expect(api.last()!.body).toEqual({ helpful: true });
  });
});

describe("customer tickets", () => {
  const newTicket = { categoryId: 1, subcategoryId: null, issueId: null, description: "It broke", details: {} };

  it("findDuplicates POSTs the narrowing fields with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.post("/support/tickets/duplicates", ok([]));
    await findDuplicates({ categoryId: 1, subcategoryId: null, issueId: null, orderId: null });
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("createTicket sends a FormData with the JSON payload and attached files", async () => {
    api.post("/support/tickets", (req) => ({ ticket: { id: "T1" }, key: null, echo: req.body }));
    const file = new File(["x"], "photo.png", { type: "image/png" });
    await createTicket(newTicket, [file]);
    const body = api.last()!.body;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse(formField(body, "data") as string)).toMatchObject({ description: "It broke" });
    expect((body as FormData).getAll("files")).toHaveLength(1);
    expect(api.last()!.headers["content-type"]).toBeUndefined(); // browser sets the multipart boundary itself
  });

  it("startChat posts to /support/chat the same way", async () => {
    api.post("/support/chat", { ticket: { id: "T1" }, key: null, chat: { available: true, reason: "", hours: "" } });
    await startChat(newTicket);
    expect(formField(api.last()!.body, "data")).toBeTruthy();
  });

  it("listMyTickets sends status/q as query params", async () => {
    api.get(/\/support\/tickets/, ok([]));
    await listMyTickets("open", "refund");
    const request = api.last()!;
    expect(request.query.get("status")).toBe("open");
    expect(request.query.get("q")).toBe("refund");
  });

  it("getMyTicket sends the ticket key header only when one is given", async () => {
    api.get("/support/tickets/T1", { id: "T1" });
    await getMyTicket("T1");
    expect(api.last()!.headers["x-ticket-key"]).toBeUndefined();
    await getMyTicket("T1", "guest-key");
    expect(api.last()!.headers["x-ticket-key"]).toBe("guest-key");
  });

  it("replyToTicket sends the body and files as FormData", async () => {
    api.post("/support/tickets/T1/messages", (req) => ({ id: "T1", echo: req.body }));
    await replyToTicket("T1", "Thanks!", [new File(["x"], "a.txt")]);
    const body = api.last()!.body as FormData;
    expect(body.get("body")).toBe("Thanks!");
    expect(body.getAll("files")).toHaveLength(1);
  });

  it("markTicketRead / sendTyping / closeMyTicket / reopenMyTicket / rateMyTicket all hit their endpoints", async () => {
    api.post("/support/tickets/T1/read", {});
    await markTicketRead("T1");
    api.post("/support/tickets/T1/typing", {});
    await sendTyping("T1");
    api.post("/support/tickets/T1/close", { id: "T1" });
    await closeMyTicket("T1");
    api.post("/support/tickets/T1/reopen", (req) => ({ id: "T1", echo: req.body }));
    await reopenMyTicket("T1", "Still broken");
    expect(api.last()!.body).toEqual({ reason: "Still broken" });
    api.post("/support/tickets/T1/feedback", (req) => ({ id: "T1", echo: req.body }));
    await rateMyTicket("T1", 5, "Great help");
    expect(api.last()!.body).toEqual({ rating: 5, comment: "Great help" });
  });

  it("customerAttachmentLink GETs the attachment URL", async () => {
    api.get("/support/tickets/T1/attachments/9", { url: "https://x/a.png", name: "a.png", contentType: "image/png" });
    const result = await customerAttachmentLink("T1", 9);
    expect(result.name).toBe("a.png");
  });

  it("listMyNotifications / markMyNotificationsRead", async () => {
    api.get("/support/notifications", ok([]));
    await listMyNotifications();
    api.post("/support/notifications/read", {});
    await markMyNotificationsRead();
    expect(api.requests("POST", "/support/notifications/read")).toHaveLength(1);
  });
});

describe("staff desk", () => {
  it("getSupportMe / getDeskLookups use admin auth", async () => {
    window.localStorage.setItem("dcz:admin-token", "adm");
    api.get("/admin/support/me", { canWork: true, seesEverything: true, canConfigure: true, agent: null });
    await getSupportMe();
    expect(api.last()!.headers.authorization).toBe("Bearer adm");

    api.get("/admin/support/lookups", { teams: [], agents: [], categories: [], statuses: [], priorities: [], featureStages: [], contactTypes: [], canned: [] });
    await getDeskLookups();
  });

  it("getSupportDashboard defaults to 30 days and accepts a custom range", async () => {
    api.get(/\/admin\/support\/dashboard/, {});
    await getSupportDashboard();
    expect(api.last()!.query.get("days")).toBe("30");
    await getSupportDashboard(7);
    expect(api.last()!.query.get("days")).toBe("7");
  });

  it("listDeskTickets builds a query from the filters and reads a paginated page", async () => {
    api.get(/\/admin\/support\/tickets/, ok([{ id: "T1" }], { total: 1 }));
    const result = await listDeskTickets({ status: "open", page: 2 });
    expect(result.items).toHaveLength(1);
    const request = api.last()!;
    expect(request.query.get("status")).toBe("open");
    expect(request.query.get("page")).toBe("2");
  });

  it("getDeskTicket GETs a single ticket", async () => {
    api.get("/admin/support/tickets/T1", { id: "T1" });
    expect((await getDeskTicket("T1") as { id: string }).id).toBe("T1");
  });

  it("postDeskMessage sends body/internal/status and files as FormData", async () => {
    api.post("/admin/support/tickets/T1/messages", (req) => ({ id: "T1", echo: req.body }));
    await postDeskMessage("T1", { body: "Looking into it", internal: true, status: "in-progress" }, [new File(["x"], "n.txt")]);
    const body = api.last()!.body as FormData;
    expect(body.get("body")).toBe("Looking into it");
    expect(body.get("internal")).toBe("true");
    expect(body.get("status")).toBe("in-progress");
    expect(body.getAll("files")).toHaveLength(1);
  });

  it("postDeskMessage omits status when not given", async () => {
    api.post("/admin/support/tickets/T1/messages", { id: "T1" });
    await postDeskMessage("T1", { body: "x", internal: false }, []);
    const body = api.last()!.body as FormData;
    expect(body.get("status")).toBeNull();
    expect(body.get("internal")).toBe("false");
  });

  it("setDeskStatus / setDeskAssignment / setDeskPriority / setDeskStage PUT their fields", async () => {
    api.put("/admin/support/tickets/T1/status", (req) => ({ id: "T1", echo: req.body }));
    await setDeskStatus("T1", "resolved", "Fixed");
    expect(api.last()!.body).toEqual({ status: "resolved", note: "Fixed" });

    api.put("/admin/support/tickets/T1/status", { id: "T1" });
    await setDeskStatus("T1", "resolved");
    expect(api.last()!.body).toEqual({ status: "resolved", note: "" });

    api.put("/admin/support/tickets/T1/assignment", (req) => ({ id: "T1", echo: req.body }));
    await setDeskAssignment("T1", 2, 5);
    expect(api.last()!.body).toEqual({ teamId: 2, agentId: 5 });

    api.put("/admin/support/tickets/T1/priority", (req) => ({ id: "T1", echo: req.body }));
    await setDeskPriority("T1", "urgent");
    expect(api.last()!.body).toEqual({ priority: "urgent" });

    api.put("/admin/support/tickets/T1/stage", (req) => ({ id: "T1", echo: req.body }));
    await setDeskStage("T1", "triage");
    expect(api.last()!.body).toEqual({ stage: "triage" });
  });

  it("escalateDeskTicket / mergeDeskTicket / linkDeskTicket / unlinkDeskTicket", async () => {
    api.post("/admin/support/tickets/T1/escalate", (req) => ({ id: "T1", echo: req.body }));
    await escalateDeskTicket("T1", "No response in 24h");
    expect(api.last()!.body).toEqual({ reason: "No response in 24h" });

    api.post("/admin/support/tickets/T1/merge", (req) => ({ id: "T1", echo: req.body }));
    await mergeDeskTicket("T1", "T2");
    expect(api.last()!.body).toEqual({ other: "T2" });

    api.post("/admin/support/tickets/T1/links", (req) => ({ id: "T1", echo: req.body }));
    await linkDeskTicket("T1", "T3");
    expect(api.last()!.body).toEqual({ other: "T3" });

    api.delete("/admin/support/tickets/T1/links/T3", { id: "T1" });
    await unlinkDeskTicket("T1", "T3");
    expect(api.requests("DELETE", "/admin/support/tickets/T1/links/T3")).toHaveLength(1);
  });

  it("markDeskRead / sendDeskTyping / deskAttachmentLink", async () => {
    api.post("/admin/support/tickets/T1/read", {});
    await markDeskRead("T1");
    api.post("/admin/support/tickets/T1/typing", {});
    await sendDeskTyping("T1");
    api.get("/admin/support/tickets/T1/attachments/4", { url: "x", name: "a", contentType: "image/png" });
    const link = await deskAttachmentLink("T1", 4);
    expect(link.name).toBe("a");
  });
});

describe("configuration", () => {
  it("getSupportConfiguration / saveSupportSettings", async () => {
    api.get("/admin/support/config", {});
    await getSupportConfiguration();

    api.put("/admin/support/config/settings", (req) => req.body);
    await saveSupportSettings({ slaWarningPercent: 80 });
    expect(api.last()!.body).toEqual({ slaWarningPercent: 80 });
  });

  it("saveConfigRow POSTs a new row without an id, PUTs with one", async () => {
    api.post("/admin/support/config/teams", (req) => ({ id: 1, ...(req.body as object) }));
    await saveConfigRow("teams", { name: "Support" });
    expect(api.last()!.method).toBe("POST");

    api.put("/admin/support/config/teams/1", (req) => ({ id: 1, ...(req.body as object) }));
    await saveConfigRow("teams", { name: "Renamed" }, 1);
    expect(api.last()!.method).toBe("PUT");
  });

  it("deleteConfigRow DELETEs the row", async () => {
    api.delete("/admin/support/config/teams/1", {});
    await deleteConfigRow("teams", 1);
    expect(api.requests("DELETE", "/admin/support/config/teams/1")).toHaveLength(1);
  });

  it("saveEmailTemplate PUTs the template content", async () => {
    api.put("/admin/support/config/templates/welcome", (req) => ({ key: "welcome", audience: "customer", label: "", enabled: true, updatedAt: "", ...(req.body as object) }));
    const result = await saveEmailTemplate("welcome", { subject: "Hi", body: "Body", enabled: true });
    expect(result.subject).toBe("Hi");
  });

  it("previewEmailTemplate POSTs subject/body and returns rendered html", async () => {
    api.post("/admin/support/config/templates/preview", { subject: "Hi {{name}}", html: "<p>Hi Asha</p>" });
    const result = await previewEmailTemplate("Hi {{name}}", "Body");
    expect(result.html).toBe("<p>Hi Asha</p>");
  });
});

describe("reason", () => {
  it("uses an ApiError's own message", () => {
    const error = new ApiError("That code has expired.", 400, "EXPIRED");
    expect(reason(error)).toBe("That code has expired.");
  });

  it("falls back to the given fallback for a non-API error", () => {
    expect(reason(new Error("boom"), "Custom fallback")).toBe("Custom fallback");
  });

  it("falls back to the default fallback when none is given", () => {
    expect(reason(new Error("boom"))).toBe("Something went wrong. Please try again.");
  });

  it("falls back when the ApiError has an empty message", () => {
    const error = new ApiError("", 500, "X");
    expect(reason(error, "fallback")).toBe("fallback");
  });
});
