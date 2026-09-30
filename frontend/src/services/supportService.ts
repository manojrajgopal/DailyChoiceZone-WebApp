/**
 * The support centre.
 *
 * Customers raise requests through a category tree the store configures, read
 * and answer their own tickets, and chat. Staff work the desk; the super admin
 * configures who handles what. Every call throws `ApiError` on failure, and
 * its `message` is written for people, so it can be shown as it is.
 *
 * A guest opens their ticket with the key emailed to them. It travels in the
 * `X-Ticket-Key` header — never in a URL the API would log.
 */

import {
  ApiError,
  apiDelete,
  apiGet,
  apiGetPage,
  apiPost,
  apiPut,
  query,
  type Page,
} from "@/services/api/client";

const CUSTOMER = { auth: "customer" } as const;
const ADMIN = { auth: "admin" } as const;

/* ==================================================================== types */

export type TicketPriority = "low" | "medium" | "high" | "urgent";

export type TicketStatus =
  | "submitted"
  | "triaged"
  | "assigned"
  | "acknowledged"
  | "in-progress"
  | "waiting-customer"
  | "waiting-internal"
  | "escalated"
  | "resolved"
  | "closed"
  | "reopened";

/** The set of fields the contact form asks for, chosen per category. */
export type SupportForm =
  | "order"
  | "product"
  | "delivery"
  | "payment"
  | "membership"
  | "account"
  | "bug"
  | "partnership"
  | "feature"
  | "feedback"
  | "general";

export interface SupportCategory {
  id: number;
  parentId: number | null;
  level: number;
  name: string;
  slug: string;
  description: string;
  icon: string;
  contactType: string;
  form: string;
  teamId: number | null;
  priority: string;
  slaHours: number;
  customerChoice: string;
  choiceTeamIds: number[];
  active: boolean;
  sortOrder: number;
  /** What the node inherits from its ancestors and the store defaults. */
  resolved: {
    contactType: string;
    form: SupportForm;
    priority: TicketPriority;
    customerChoice: string;
    choiceTeamIds: number[];
    teamId: number | null;
  };
  children: SupportCategory[];
}

export interface ChatStatus {
  available: boolean;
  /** disabled | closed | nobody */
  reason: string;
  hours: string;
}

export interface SupportCentreConfig {
  categories: SupportCategory[];
  chat: ChatStatus;
  hours: string;
  open: boolean;
  attachments: { enabled: boolean; maxFiles: number; maxSizeMb: number; maxVideoSizeMb: number };
  reopenDays: number;
  /** Hours to a first reply, per priority. */
  responseTargets: Record<TicketPriority, number>;
}

export interface Handler {
  id: number;
  name: string;
  role: string;
  specialization: string;
  photoUrl: string;
  available: boolean;
}

export interface HandlerChoice {
  /** "" (none) | team | agent */
  choice: string;
  teams: { id: number; name: string; description: string; agents: Handler[] }[];
}

export interface HelpArticle {
  id: number;
  title: string;
  slug: string;
  summary: string;
  body?: string;
  categoryIds: number[];
  keywords: string;
  active: boolean;
  views: number;
  helpful: number;
  notHelpful: number;
  sortOrder: number;
  updatedAt: string;
}

export interface SlaState {
  /** none | on-track | due-soon | breached | met | paused */
  state: string;
  dueAt: string | null;
  minutesLeft: number | null;
}

export interface TicketAttachment {
  id: number;
  messageId: number | null;
  name: string;
  contentType: string;
  size: number;
  isImage: boolean;
  internal: boolean;
  uploadedBy: string;
  createdAt: string;
}

export interface TicketMessage {
  id: number;
  /** customer | agent | system | note (staff only) */
  kind: "customer" | "agent" | "system" | "note";
  author: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  attachments: TicketAttachment[];
}

export interface TicketRow {
  id: string;
  number: string;
  subject: string;
  category: string;
  subcategory: string;
  issue: string;
  contactType: string;
  channel: string;
  priority: TicketPriority;
  status: TicketStatus;
  statusLabel: string;
  featureStage: string;
  team: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessage: string;
  unread: number;
  sla: SlaState;
  orderNumber: string;
}

export interface StaffTicketRow extends TicketRow {
  customerName: string;
  customerEmail: string;
  customerId: string | null;
  escalationLevel: number;
  teamId: number | null;
  agentId: number | null;
  mergedInto: string | null;
}

export interface TicketDetail {
  key: string;
  label: string;
  value: string;
}

export interface TicketOrder {
  id: string;
  number: string;
  placedAt: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  total: number;
  items: {
    name: string;
    quantity: number;
    image: string;
    productId: string | null;
    size: string | null;
    color: string | null;
    lineTotal: number;
  }[];
}

export interface TicketProduct {
  id: string;
  name: string;
  brand: string;
  slug: string;
  image: string;
  price: number;
}

export interface AgentCard {
  id: number;
  name: string;
  role: string;
  photoUrl: string;
  /** Staff views only. */
  email?: string;
}

/** A ticket as its customer sees it: no notes, no audit trail, no staff emails. */
export interface CustomerTicket extends TicketRow {
  description: string;
  details: TicketDetail[];
  priorityLabel: string;
  featureStageLabel: string;
  teamName: string;
  agentCard: AgentCard | null;
  responseDueAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  order: TicketOrder | null;
  product: TicketProduct | null;
  messages: TicketMessage[];
  agentTyping: boolean;
  mergedInto: string | null;
  canReply: boolean;
  canClose: boolean;
  canReopen: boolean;
  reopenUntil: string | null;
  canRate: boolean;
  feedback: { rating: number; comment: string } | null;
  attachmentsEnabled: boolean;
}

export interface TicketEvent {
  id: number;
  kind: string;
  from: string;
  to: string;
  note: string;
  actorKind: string;
  actor: string;
  at: string;
}

export interface StaffTicket extends StaffTicketRow {
  description: string;
  details: TicketDetail[];
  priorityLabel: string;
  featureStageLabel: string;
  agentCard: AgentCard | null;
  phone: string;
  responseDueAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenedCount: number;
  slaBreached: boolean;
  /** The moves the backend allows from here — the only ones offered. */
  transitions: { value: TicketStatus; label: string }[];
  customer: {
    id: string | null;
    name: string;
    email: string;
    phone: string;
    orders: number;
    since?: string;
    guest?: boolean;
  };
  order: TicketOrder | null;
  product: TicketProduct | null;
  membership: { id: string; plan: string; status: string; startsAt: string; endsAt: string } | null;
  messages: TicketMessage[];
  events: TicketEvent[];
  links: { id: string; number: string; subject: string; status: string; statusLabel: string; kind: string }[];
  feedback: { rating: number; comment: string; at: string } | null;
  customerTyping: boolean;
  attachmentsEnabled: boolean;
}

export interface CustomerNotification {
  id: number;
  kind: string;
  title: string;
  body: string;
  href: string;
  read: boolean;
  at: string;
}

/* ================================================================ customer */

/**
 * Options for a call a guest may make: the customer's token when signed in,
 * and the emailed key when there is one. A signed-in customer reaches their
 * own tickets by account; the key is for a guest following an emailed link.
 */
function keyed(key?: string | null) {
  return { ...CUSTOMER, headers: key ? { "X-Ticket-Key": key } : undefined };
}

export function getSupportConfig(): Promise<SupportCentreConfig> {
  return apiGet("/support/config");
}

export function getHandlers(categoryId: number): Promise<HandlerChoice> {
  return apiGet(`/support/categories/${categoryId}/handlers`);
}

export function searchArticles(q: string, categoryIds: number[] = []): Promise<HelpArticle[]> {
  return apiGet(`/support/articles${query({ q, categories: categoryIds })}`);
}

export function getArticle(slug: string): Promise<HelpArticle> {
  return apiGet(`/support/articles/${encodeURIComponent(slug)}`);
}

export function rateArticle(id: number, helpful: boolean): Promise<void> {
  return apiPost(`/support/articles/${id}/feedback`, { helpful });
}

export interface NewTicket {
  categoryId: number | null;
  subcategoryId: number | null;
  issueId: number | null;
  subject?: string;
  description: string;
  details: Record<string, string>;
  orderId?: string | null;
  productId?: string | null;
  teamId?: number | null;
  agentId?: number | null;
  /** Guests only. */
  name?: string;
  email?: string;
  phone?: string;
  /** The honeypot: always empty from a person. */
  website?: string;
}

function ticketForm(payload: NewTicket, files: File[]): FormData {
  const form = new FormData();
  form.set("data", JSON.stringify(payload));
  for (const file of files) form.append("files", file, file.name);
  return form;
}

export function findDuplicates(payload: Pick<NewTicket, "categoryId" | "subcategoryId" | "issueId" | "orderId">): Promise<TicketRow[]> {
  return apiPost("/support/tickets/duplicates", payload, CUSTOMER);
}

/** Raise a request. `key` is set for a guest: it opens the ticket later. */
export function createTicket(
  payload: NewTicket,
  files: File[],
): Promise<{ ticket: CustomerTicket; key: string | null }> {
  return apiPost("/support/tickets", ticketForm(payload, files), CUSTOMER);
}

export function startChat(
  payload: NewTicket,
  files: File[] = [],
): Promise<{ ticket: CustomerTicket; key: string | null; chat: ChatStatus }> {
  return apiPost("/support/chat", ticketForm(payload, files), CUSTOMER);
}

export function listMyTickets(status = "", q = ""): Promise<TicketRow[]> {
  return apiGet(`/support/tickets${query({ status, q })}`, CUSTOMER);
}

export function getMyTicket(number: string, key?: string | null): Promise<CustomerTicket> {
  return apiGet(`/support/tickets/${encodeURIComponent(number)}`, keyed(key));
}

export function replyToTicket(number: string, body: string, files: File[], key?: string | null): Promise<CustomerTicket> {
  const form = new FormData();
  form.set("body", body);
  for (const file of files) form.append("files", file, file.name);
  return apiPost(`/support/tickets/${encodeURIComponent(number)}/messages`, form, keyed(key));
}

export function markTicketRead(number: string, key?: string | null): Promise<void> {
  return apiPost(`/support/tickets/${encodeURIComponent(number)}/read`, {}, keyed(key));
}

export function sendTyping(number: string, key?: string | null): Promise<void> {
  return apiPost(`/support/tickets/${encodeURIComponent(number)}/typing`, {}, keyed(key));
}

export function closeMyTicket(number: string, key?: string | null): Promise<CustomerTicket> {
  return apiPost(`/support/tickets/${encodeURIComponent(number)}/close`, {}, keyed(key));
}

export function reopenMyTicket(number: string, reason: string, key?: string | null): Promise<CustomerTicket> {
  return apiPost(`/support/tickets/${encodeURIComponent(number)}/reopen`, { reason }, keyed(key));
}

export function rateMyTicket(number: string, rating: number, comment: string, key?: string | null): Promise<CustomerTicket> {
  return apiPost(`/support/tickets/${encodeURIComponent(number)}/feedback`, { rating, comment }, keyed(key));
}

export function customerAttachmentLink(
  number: string,
  attachmentId: number,
  key?: string | null,
): Promise<{ url: string; name: string; contentType: string }> {
  return apiGet(`/support/tickets/${encodeURIComponent(number)}/attachments/${attachmentId}`, keyed(key));
}

export function listMyNotifications(): Promise<CustomerNotification[]> {
  return apiGet("/support/notifications", CUSTOMER);
}

export function markMyNotificationsRead(): Promise<void> {
  return apiPost("/support/notifications/read", {}, CUSTOMER);
}

/* ==================================================================== staff */

export interface SupportMe {
  canWork: boolean;
  seesEverything: boolean;
  canConfigure: boolean;
  agent: SupportAgent | null;
}

export interface SupportDashboard {
  days: number;
  totals: {
    total: number;
    open: number;
    inProgress: number;
    waitingCustomer: number;
    urgent: number;
    resolved: number;
    closed: number;
    slaBreached: number;
    createdInRange: number;
  };
  byStatus: { label: string; status: string; value: number }[];
  byCategory: { label: string; value: number }[];
  byPriority: { label: string; value: number }[];
  byTeam: { label: string; value: number }[];
  byAgent: { label: string; total: number; open: number; resolved: number; rating: number | null }[];
  byChannel: { label: string; value: number }[];
  overTime: { date: string; created: number; resolved: number }[];
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  slaCompliance: number | null;
  satisfaction: {
    average: number | null;
    count: number;
    positivePercent: number | null;
    distribution: { label: string; value: number }[];
    recent: { ticketId: string; rating: number; comment: string; at: string }[];
  };
}

export interface DeskLookups {
  teams: { id: number; name: string; active: boolean }[];
  agents: { id: number; name: string; teamId: number | null; active: boolean; available: boolean }[];
  categories: SupportCategory[];
  statuses: { value: TicketStatus; label: string }[];
  priorities: { value: TicketPriority; label: string }[];
  featureStages: { value: string; label: string }[];
  contactTypes: string[];
  canned: { id: number; title: string; body: string; categoryId: number | null }[];
}

export interface DeskFilters {
  view?: string;
  status?: string;
  category?: string;
  subcategory?: string;
  priority?: string;
  team?: string;
  agent?: string;
  contactType?: string;
  channel?: string;
  customer?: string;
  sla?: string;
  q?: string;
  sort?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function getSupportMe(): Promise<SupportMe> {
  return apiGet("/admin/support/me", ADMIN);
}

export function getSupportDashboard(days = 30): Promise<SupportDashboard> {
  return apiGet(`/admin/support/dashboard${query({ days })}`, ADMIN);
}

export function getDeskLookups(): Promise<DeskLookups> {
  return apiGet("/admin/support/lookups", ADMIN);
}

export function listDeskTickets(filters: DeskFilters): Promise<Page<StaffTicketRow>> {
  return apiGetPage(`/admin/support/tickets${query({ ...filters })}`, ADMIN);
}

export function getDeskTicket(id: string): Promise<StaffTicket> {
  return apiGet(`/admin/support/tickets/${encodeURIComponent(id)}`, ADMIN);
}

export function postDeskMessage(
  id: string,
  input: { body: string; internal: boolean; status?: string },
  files: File[],
): Promise<StaffTicket> {
  const form = new FormData();
  form.set("body", input.body);
  form.set("internal", input.internal ? "true" : "false");
  if (input.status) form.set("status", input.status);
  for (const file of files) form.append("files", file, file.name);
  return apiPost(`/admin/support/tickets/${encodeURIComponent(id)}/messages`, form, ADMIN);
}

export function setDeskStatus(id: string, status: string, note = ""): Promise<StaffTicket> {
  return apiPut(`/admin/support/tickets/${encodeURIComponent(id)}/status`, { status, note }, ADMIN);
}

export function setDeskAssignment(id: string, teamId: number | null, agentId: number | null): Promise<StaffTicket> {
  return apiPut(`/admin/support/tickets/${encodeURIComponent(id)}/assignment`, { teamId, agentId }, ADMIN);
}

export function setDeskPriority(id: string, priority: string): Promise<StaffTicket> {
  return apiPut(`/admin/support/tickets/${encodeURIComponent(id)}/priority`, { priority }, ADMIN);
}

export function setDeskStage(id: string, stage: string): Promise<StaffTicket> {
  return apiPut(`/admin/support/tickets/${encodeURIComponent(id)}/stage`, { stage }, ADMIN);
}

export function escalateDeskTicket(id: string, reason: string): Promise<StaffTicket> {
  return apiPost(`/admin/support/tickets/${encodeURIComponent(id)}/escalate`, { reason }, ADMIN);
}

export function mergeDeskTicket(id: string, other: string): Promise<StaffTicket> {
  return apiPost(`/admin/support/tickets/${encodeURIComponent(id)}/merge`, { other }, ADMIN);
}

export function linkDeskTicket(id: string, other: string): Promise<StaffTicket> {
  return apiPost(`/admin/support/tickets/${encodeURIComponent(id)}/links`, { other }, ADMIN);
}

export function unlinkDeskTicket(id: string, otherId: string): Promise<StaffTicket> {
  return apiDelete(`/admin/support/tickets/${encodeURIComponent(id)}/links/${encodeURIComponent(otherId)}`, ADMIN);
}

export function markDeskRead(id: string): Promise<void> {
  return apiPost(`/admin/support/tickets/${encodeURIComponent(id)}/read`, {}, ADMIN);
}

export function sendDeskTyping(id: string): Promise<void> {
  return apiPost(`/admin/support/tickets/${encodeURIComponent(id)}/typing`, {}, ADMIN);
}

export function deskAttachmentLink(id: string, attachmentId: number): Promise<{ url: string; name: string; contentType: string }> {
  return apiGet(`/admin/support/tickets/${encodeURIComponent(id)}/attachments/${attachmentId}`, ADMIN);
}

/* ============================================================ configuration */

export interface EscalationRule {
  id: string;
  label: string;
  /** no-response | sla-breached | unresolved */
  when: string;
  afterMinutes: number;
  priorities: TicketPriority[];
  /** team-lead | admins | super-admins */
  notify: string;
}

export type DayHours = { open: string; close: string } | null;

export interface SupportSettings {
  ticketPrefix: string;
  defaultPriority: TicketPriority;
  defaultTeamId: number | null;
  sla: Record<TicketPriority, { response: number; resolve: number }>;
  slaWarningPercent: number;
  escalation: EscalationRule[];
  businessHours: { timezone: string; days: Record<string, DayHours> };
  holidays: { date: string; name: string }[];
  chat: { enabled: boolean; onlyInBusinessHours: boolean };
  reopenDays: number;
  autoCloseResolvedDays: number;
  duplicateWindowDays: number;
  attachments: { maxFiles: number; maxSizeMb: number; maxVideoSizeMb: number };
}

export interface SupportDepartment {
  id: number;
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
  teams: number;
}

export interface SupportRole {
  id: number;
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
  agents: number;
}

export interface SupportTeam {
  id: number;
  name: string;
  departmentId: number | null;
  department: string;
  description: string;
  notifyEmail: string;
  assignment: string;
  customerSelectable: boolean;
  active: boolean;
  sortOrder: number;
  agents: number;
  activeAgents: number;
  availableAgents: number;
  openTickets: number;
}

export interface SupportAgent {
  id: number;
  name: string;
  email: string;
  phone: string;
  photoUrl: string;
  roleId: number | null;
  role: string;
  teamId: number | null;
  team: string;
  specialization: string;
  active: boolean;
  available: boolean;
  isLead: boolean;
  showToCustomers: boolean;
  notifyEmail: boolean;
  notifyPortal: boolean;
  adminUserId: string | null;
  adminUser: { id: string; name: string; email: string; role: string } | null;
  openTickets: number;
}

export interface CannedReply {
  id: number;
  title: string;
  body: string;
  categoryId: number | null;
  active: boolean;
  updatedAt: string;
}

export interface EmailTemplate {
  key: string;
  audience: "customer" | "internal";
  label: string;
  subject: string;
  body: string;
  enabled: boolean;
  updatedAt: string;
}

export interface SupportConfiguration {
  settings: SupportSettings;
  departments: SupportDepartment[];
  roles: SupportRole[];
  teams: SupportTeam[];
  agents: SupportAgent[];
  categories: SupportCategory[];
  articles: HelpArticle[];
  canned: CannedReply[];
  templates: EmailTemplate[];
  portalAccounts: { id: string; name: string; email: string; role: string }[];
  variables: string[];
  options: {
    priorities: TicketPriority[];
    contactTypes: string[];
    forms: SupportForm[];
    assignment: string[];
    escalationWhen: string[];
    escalationNotify: string[];
  };
  attachmentsEnabled: boolean;
}

export type ConfigList = "departments" | "roles" | "teams" | "agents" | "categories" | "articles" | "canned";

export function getSupportConfiguration(): Promise<SupportConfiguration> {
  return apiGet("/admin/support/config", ADMIN);
}

export function saveSupportSettings(settings: Partial<SupportSettings>): Promise<SupportSettings> {
  return apiPut("/admin/support/config/settings", settings, ADMIN);
}

export function saveConfigRow(list: ConfigList, payload: object, id?: number | null): Promise<unknown> {
  return id
    ? apiPut(`/admin/support/config/${list}/${id}`, payload, ADMIN)
    : apiPost(`/admin/support/config/${list}`, payload, ADMIN);
}

export function deleteConfigRow(list: ConfigList, id: number): Promise<void> {
  return apiDelete(`/admin/support/config/${list}/${id}`, ADMIN);
}

export function saveEmailTemplate(key: string, payload: { subject: string; body: string; enabled: boolean }): Promise<EmailTemplate> {
  return apiPut(`/admin/support/config/templates/${encodeURIComponent(key)}`, payload, ADMIN);
}

export function previewEmailTemplate(subject: string, body: string): Promise<{ subject: string; html: string }> {
  return apiPost("/admin/support/config/templates/preview", { subject, body }, ADMIN);
}

/** A failure as one line for a toast or an inline error. */
export function reason(error: unknown, fallback = "Something went wrong. Please try again."): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}
