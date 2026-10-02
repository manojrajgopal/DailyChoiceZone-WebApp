/**
 * Support desk fixtures for slice H (AdminSupportDeskView, AdminTicketDetailView, SupportDeskParts).
 *
 *   serveSupportMe({ seesEverything: false })   // answers /admin/support/me
 *   deskRow({ unread: 2 })                      // one row of the desk list
 *   deskTicket({ channel: "chat" })             // a full staff ticket
 *   deskLookups(), supportDashboard()           // the desk's reference data and figures
 */
import type {
  DeskLookups,
  StaffTicket,
  StaffTicketRow,
  SupportAgent,
  SupportCategory,
  SupportDashboard,
  SupportMe,
} from "@/services/supportService";

import { api } from "./api";

/** A fixed "now" for every desk test: 2 Oct 2026, 11:30 am in Kolkata. */
export const NOW = new Date("2026-10-02T06:00:00.000Z");

export function supportAgent(overrides: Partial<SupportAgent> = {}): SupportAgent {
  return {
    id: 7,
    name: "Meera Iyer",
    email: "meera@example.com",
    phone: "",
    photoUrl: "",
    roleId: 1,
    role: "Agent",
    teamId: 1,
    team: "Orders",
    specialization: "",
    active: true,
    available: true,
    isLead: false,
    showToCustomers: true,
    notifyEmail: true,
    notifyPortal: true,
    adminUserId: "ADM1",
    adminUser: null,
    openTickets: 3,
    ...overrides,
  };
}

export function supportMe(overrides: Partial<SupportMe> = {}): SupportMe {
  return { canWork: true, seesEverything: true, canConfigure: true, agent: supportAgent(), ...overrides };
}

export function serveSupportMe(overrides: Partial<SupportMe> = {}): SupportMe {
  const me = supportMe(overrides);
  api.get("/admin/support/me", me);
  return me;
}

export function category(overrides: Partial<SupportCategory> = {}): SupportCategory {
  return {
    id: 10,
    parentId: null,
    level: 0,
    name: "Orders",
    slug: "orders",
    description: "",
    icon: "",
    contactType: "support",
    form: "order",
    teamId: 1,
    priority: "medium",
    slaHours: 24,
    customerChoice: "",
    choiceTeamIds: [],
    active: true,
    sortOrder: 0,
    resolved: { contactType: "support", form: "order", priority: "medium", customerChoice: "", choiceTeamIds: [], teamId: 1 },
    children: [],
    ...overrides,
  };
}

export function deskLookups(overrides: Partial<DeskLookups> = {}): DeskLookups {
  return {
    teams: [
      { id: 1, name: "Orders", active: true },
      { id: 2, name: "Payments", active: true },
      { id: 3, name: "Old team", active: false },
    ],
    agents: [
      { id: 7, name: "Meera Iyer", teamId: 1, active: true, available: true },
      { id: 8, name: "Ravi Kumar", teamId: 1, active: true, available: false },
      { id: 9, name: "Sana Ali", teamId: 2, active: true, available: true },
      { id: 11, name: "Gone Person", teamId: 1, active: false, available: false },
    ],
    categories: [
      category({
        children: [
          category({ id: 11, parentId: 10, level: 1, name: "Late delivery", slug: "late" }),
          category({ id: 12, parentId: 10, level: 1, name: "Damaged item", slug: "damaged" }),
        ],
      }),
      category({ id: 20, name: "Payments", slug: "payments" }),
    ],
    statuses: [
      { value: "submitted", label: "Submitted" },
      { value: "resolved", label: "Resolved" },
    ],
    priorities: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "urgent", label: "Urgent" },
    ],
    featureStages: [
      { value: "under-review", label: "Under review" },
      { value: "planned", label: "Planned" },
    ],
    contactTypes: ["support", "feature"],
    canned: [{ id: 1, title: "Greeting", body: "Hello, thanks for writing in.", categoryId: null }],
    ...overrides,
  };
}

export function deskRow(overrides: Partial<StaffTicketRow> = {}): StaffTicketRow {
  return {
    id: "T1",
    number: "DCZ-2026-000101",
    subject: "Parcel not arrived",
    category: "Orders",
    subcategory: "Late delivery",
    issue: "",
    contactType: "support",
    channel: "form",
    priority: "high",
    status: "assigned",
    statusLabel: "Assigned",
    featureStage: "",
    team: "Orders",
    agent: "Meera Iyer",
    createdAt: "2026-10-01T06:00:00",
    updatedAt: "2026-10-02T05:55:00",
    lastMessageAt: null,
    lastMessage: "",
    unread: 0,
    sla: { state: "on-track", dueAt: "2026-10-02T08:00:00", minutesLeft: 120 },
    orderNumber: "",
    customerName: "Anil Shah",
    customerEmail: "anil@example.com",
    customerId: "C1",
    escalationLevel: 0,
    teamId: 1,
    agentId: 7,
    mergedInto: null,
    ...overrides,
  };
}

export function supportDashboard(overrides: Partial<SupportDashboard> = {}): SupportDashboard {
  return {
    days: 30,
    totals: {
      total: 40,
      open: 12,
      inProgress: 5,
      waitingCustomer: 3,
      urgent: 2,
      resolved: 15,
      closed: 5,
      slaBreached: 0,
      createdInRange: 22,
    },
    byStatus: [],
    byCategory: [{ label: "Orders", value: 14 }],
    byPriority: [{ label: "High", value: 4 }],
    byTeam: [{ label: "Payments team", value: 9 }],
    byAgent: [
      { label: "Meera Iyer", total: 10, open: 2, resolved: 8, rating: 4.5 },
      { label: "Ravi Kumar", total: 4, open: 4, resolved: 0, rating: null },
    ],
    byChannel: [
      { label: "chat", value: 6 },
      { label: "form", value: 16 },
    ],
    overTime: [
      { date: "2026-09-30", created: 3, resolved: 1 },
      { date: "2026-10-01", created: 5, resolved: 2 },
    ],
    avgFirstResponseMinutes: 84,
    avgResolutionMinutes: 2900,
    slaCompliance: 92,
    satisfaction: {
      average: 4.25,
      count: 8,
      positivePercent: 75,
      distribution: [{ label: "5 stars", value: 5 }],
      recent: [{ ticketId: "T9", rating: 4, comment: "Quick help", at: "2026-10-02T05:00:00" }],
    },
    ...overrides,
  };
}

export function deskTicket(overrides: Partial<StaffTicket> = {}): StaffTicket {
  return {
    ...deskRow(),
    description: "Where is my parcel?",
    details: [{ key: "order", label: "Order number", value: "DCZ-O-1001" }],
    priorityLabel: "High",
    featureStageLabel: "",
    agentCard: { id: 7, name: "Meera Iyer", role: "Agent", photoUrl: "", email: "meera@example.com" },
    phone: "",
    responseDueAt: "2026-10-01T10:00:00",
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    reopenedCount: 0,
    slaBreached: false,
    transitions: [
      { value: "in-progress", label: "In progress" },
      { value: "resolved", label: "Resolved" },
      { value: "closed", label: "Closed" },
    ],
    customer: { id: "C1", name: "Anil Shah", email: "anil@example.com", phone: "98450 00000", orders: 3, since: "2025-01-10" },
    order: null,
    product: null,
    membership: null,
    messages: [
      { id: 1, kind: "customer", author: "Anil Shah", body: "My parcel has not arrived.", createdAt: "2026-10-01T06:00:00", readAt: null, attachments: [] },
      { id: 2, kind: "system", author: "", body: "Assigned to Meera Iyer", createdAt: "2026-10-01T06:01:00", readAt: null, attachments: [] },
    ],
    events: [
      { id: 1, kind: "created", from: "", to: "", note: "", actorKind: "customer", actor: "Anil Shah", at: "2026-10-01T06:00:00" },
    ],
    links: [],
    feedback: null,
    customerTyping: false,
    attachmentsEnabled: false,
    ...overrides,
  };
}
