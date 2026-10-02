/**
 * Support-setup fixtures for slice H (admin support settings).
 *
 *   supportConfig({ teams: [team({ id: 2 })] })   // a complete /admin/support/config payload
 *   team(), agent(), department(), role(), category(), article(), canned(), template(), supportSettings()
 */
import type {
  CannedReply,
  EmailTemplate,
  HelpArticle,
  SupportAgent,
  SupportCategory,
  SupportConfiguration,
  SupportDepartment,
  SupportRole,
  SupportSettings,
  SupportTeam,
} from "@/services/supportService";

export function department(overrides: Partial<SupportDepartment> = {}): SupportDepartment {
  return { id: 1, name: "Engineering", description: "Builds the store", active: true, sortOrder: 0, teams: 1, ...overrides };
}

export function role(overrides: Partial<SupportRole> = {}): SupportRole {
  return { id: 1, name: "Developer", description: "", active: true, sortOrder: 0, agents: 1, ...overrides };
}

export function team(overrides: Partial<SupportTeam> = {}): SupportTeam {
  return {
    id: 1,
    name: "Payments",
    departmentId: 1,
    department: "Engineering",
    description: "Payment problems",
    notifyEmail: "",
    assignment: "round-robin",
    customerSelectable: false,
    active: true,
    sortOrder: 0,
    agents: 1,
    activeAgents: 1,
    availableAgents: 1,
    openTickets: 3,
    ...overrides,
  };
}

export function agent(overrides: Partial<SupportAgent> = {}): SupportAgent {
  return {
    id: 1,
    name: "Ravi Kumar",
    email: "ravi@example.com",
    phone: "",
    photoUrl: "",
    roleId: 1,
    role: "Developer",
    teamId: 1,
    team: "Payments",
    specialization: "UPI payments",
    active: true,
    available: true,
    isLead: false,
    showToCustomers: false,
    notifyEmail: true,
    notifyPortal: true,
    adminUserId: null,
    adminUser: null,
    openTickets: 2,
    ...overrides,
  };
}

export function category(overrides: Partial<SupportCategory> = {}): SupportCategory {
  return {
    id: 1,
    parentId: null,
    level: 1,
    name: "Payments",
    slug: "payments",
    description: "Money matters",
    icon: "help",
    contactType: "support",
    form: "payment",
    teamId: 1,
    priority: "high",
    slaHours: 0,
    customerChoice: "",
    choiceTeamIds: [],
    active: true,
    sortOrder: 0,
    resolved: { contactType: "support", form: "payment", priority: "high", customerChoice: "", choiceTeamIds: [], teamId: 1 },
    children: [],
    ...overrides,
  };
}

export function article(overrides: Partial<HelpArticle> = {}): HelpArticle {
  return {
    id: 1,
    title: "How refunds work",
    slug: "how-refunds-work",
    summary: "Refunds take 5 days",
    body: "Long text",
    categoryIds: [],
    keywords: "refund",
    active: true,
    views: 10,
    helpful: 3,
    notHelpful: 1,
    sortOrder: 0,
    updatedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

export function canned(overrides: Partial<CannedReply> = {}): CannedReply {
  return { id: 1, title: "Refund on the way", body: "Your refund is on its way.", categoryId: null, active: true, updatedAt: "2026-10-01T10:00:00Z", ...overrides };
}

export function template(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    key: "ticket-created",
    audience: "customer",
    label: "Request received",
    subject: "We got your request",
    body: "Hello {{name}}",
    enabled: true,
    updatedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

export function supportSettings(overrides: Partial<SupportSettings> = {}): SupportSettings {
  return {
    ticketPrefix: "DCZ",
    defaultPriority: "medium",
    defaultTeamId: null,
    sla: {
      low: { response: 24, resolve: 72 },
      medium: { response: 8, resolve: 48 },
      high: { response: 4, resolve: 24 },
      urgent: { response: 1, resolve: 8 },
    },
    slaWarningPercent: 75,
    escalation: [],
    businessHours: {
      timezone: "Asia/Kolkata",
      days: {
        mon: { open: "09:00", close: "18:00" },
        tue: { open: "09:00", close: "18:00" },
        wed: { open: "09:00", close: "18:00" },
        thu: { open: "09:00", close: "18:00" },
        fri: { open: "09:00", close: "18:00" },
        sat: null,
        sun: null,
      },
    },
    holidays: [],
    chat: { enabled: true, onlyInBusinessHours: true },
    reopenDays: 7,
    autoCloseResolvedDays: 5,
    duplicateWindowDays: 14,
    attachments: { maxFiles: 5, maxSizeMb: 10, maxVideoSizeMb: 50 },
    ...overrides,
  };
}

export function supportConfig(overrides: Partial<SupportConfiguration> = {}): SupportConfiguration {
  return {
    settings: supportSettings(),
    departments: [department()],
    roles: [role()],
    teams: [team()],
    agents: [agent()],
    categories: [category()],
    articles: [article()],
    canned: [canned()],
    templates: [template()],
    portalAccounts: [],
    variables: ["name", "number"],
    options: {
      priorities: ["low", "medium", "high", "urgent"],
      contactTypes: ["support", "feature"],
      forms: ["general", "payment", "order"],
      assignment: ["manual", "round-robin", "least-active"],
      escalationWhen: ["no-response", "sla-breached", "unresolved"],
      escalationNotify: ["team-lead", "admins", "super-admins"],
    },
    attachmentsEnabled: true,
    ...overrides,
  };
}
