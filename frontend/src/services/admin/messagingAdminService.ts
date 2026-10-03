import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

import type { Paged } from "./operationsAdminService";

/**
 * Portal calls for notifications (every channel), marketing campaigns and
 * database backups. Permissions are checked by the server: `notifications`,
 * `campaigns`, `backups`.
 */

const ADMIN = { auth: "admin" } as const;

export type Channel = "email" | "sms" | "whatsapp" | "in_app";

export const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp", in_app: "In-app" };

/* ------------------------------------------------------------ notifications */

export interface ChannelState {
  provider: string;
  configured: boolean;
  reason: string;
  enabled: boolean;
}

export interface NotificationOverview {
  days: number;
  channels: Record<Channel, ChannelState>;
  byChannel: Record<Channel, Record<string, number> & { total: number }>;
  retrying: number;
  gaveUp: number;
  routing: Record<"sms" | "whatsapp", { enabled: boolean; events: string[] }>;
  events: { key: string; label: string; group: string; category: string }[];
}

export interface DeliveryRow {
  id: number;
  event: string;
  eventLabel: string;
  channel: Channel;
  category: "transactional" | "marketing";
  recipient: string;
  customer: { id: string; name: string } | null;
  template: string;
  provider: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  providerMessageId: string | null;
  reference: string;
  campaignId: number | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  nextAttemptAt: string | null;
  retryable: boolean;
  content?: Record<string, unknown>;
}

export interface DeliveryFilters {
  channel?: string;
  status?: string;
  event?: string;
  customer?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export const getNotificationOverview = () => apiGet<NotificationOverview>("/admin/messaging/overview", ADMIN);
export const listDeliveries = (filters: DeliveryFilters) =>
  apiGet<Paged<DeliveryRow> & { counts: Record<string, number> }>(`/admin/messaging${query({ ...filters })}`, ADMIN);
export const getDelivery = (id: number) => apiGet<DeliveryRow>(`/admin/messaging/${id}`, ADMIN);
export const retryDelivery = (id: number) => apiPost<DeliveryRow>(`/admin/messaging/${id}/retry`, {}, ADMIN);
export const saveChannelRouting = (routing: NotificationOverview["routing"]) =>
  apiPut<NotificationOverview["routing"]>("/admin/messaging/channels", routing, ADMIN);

export interface NotificationTemplate {
  key: string;
  label: string;
  group: string;
  category: "transactional" | "marketing";
  emailType: string;
  variables: string[];
  locked: boolean;
  ctaVariable: string;
  enabled: boolean;
  customised: boolean;
  subject: string;
  heading: string;
  body: string;
  cta: string;
  sms: string;
  whatsappTemplate: string;
  whatsappLanguage: string;
  whatsappVariables: string[];
  inAppTitle: string;
  inAppBody: string;
  updatedAt: string | null;
  updatedBy: string;
  default: { subject: string; heading: string; body: string; cta: string; sms: string };
}

export interface TemplatePreview {
  subject: string;
  html: string;
  text: string;
  sms: string;
  smsSegments: number;
  inApp: { title?: string; body?: string };
  whatsapp: { template?: string; variables?: string[]; text?: string };
  problems: string[];
}

export const listTemplates = () => apiGet<NotificationTemplate[]>("/admin/messaging/templates", ADMIN);
export const saveTemplate = (key: string, body: Partial<NotificationTemplate>) =>
  apiPut<NotificationTemplate>(`/admin/messaging/templates/${key}`, body, ADMIN);
export const resetTemplate = (key: string) => apiPost<NotificationTemplate>(`/admin/messaging/templates/${key}/reset`, {}, ADMIN);
export const previewTemplate = (key: string, draft?: Partial<NotificationTemplate>) =>
  apiPost<TemplatePreview>(`/admin/messaging/templates/${key}/preview`, draft ?? {}, ADMIN);
export const testTemplate = (key: string, channel: Channel, recipient: string) =>
  apiPost<{ sentTo: string }>(`/admin/messaging/templates/${key}/test`, { channel, recipient }, ADMIN);

/* ----------------------------------------------------------------- campaigns */

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled" | "failed";

export interface Audience {
  segment: "all" | "members" | "non_members" | "new" | "repeat" | "lapsed";
  joinedWithinDays?: number | null;
  orderedFrom?: string | null;
  orderedTo?: string | null;
  notOrderedDays?: number | null;
  minSpent?: number | null;
  maxSpent?: number | null;
  minOrders?: number | null;
  maxOrders?: number | null;
  productIds?: string[];
  categoryIds?: string[];
  membershipPlanIds?: string[];
  abandonedCart?: boolean;
  /** A saved customer segment; the filters above still apply on top (docs/customer-segmentation.md §6). */
  segmentId?: number | null;
}

export interface CampaignContent {
  email: { subject: string; preview: string; heading: string; html: string; ctaLabel: string; ctaUrl: string };
  sms: { text: string };
  whatsapp: { template: string; language: string; variables: string[] };
  in_app: { title: string; body: string; url: string };
}

export interface ChannelFigures {
  targeted: number;
  queued: number;
  sent: number;
  delivered: number | null;
  failed: number;
  skipped: number;
  retrying: number;
  opened: number | null;
  clicked: number | null;
  unsubscribed: number | null;
  bounced: number | null;
  replied: number | null;
  rates: { delivery: number | null; failure: number | null; open: number | null; click: number | null; unsubscribe: number | null };
}

export interface Campaign {
  id: number;
  name: string;
  description: string;
  kind: string;
  kindLabel: string;
  status: CampaignStatus;
  channels: Channel[];
  couponCode: string;
  startsAt: string | null;
  endsAt: string | null;
  scheduledAt: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  recipientsTotal: number;
  testedAt: string | null;
  contentUpdatedAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  sent?: number;
  audience?: Audience;
  content?: CampaignContent;
  readiness?: string[];
  analytics?: { channels: Record<Channel, ChannelFigures>; revenue: { orders: number; revenue: number }; openTracking: boolean; notes: string[] } | null;
}

export interface CampaignOptions {
  kinds: { value: string; label: string }[];
  segments: string[];
  variables: string[];
  starters: Record<string, { heading: string; message: string }>;
  channels: Record<Channel, ChannelState>;
  plans: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  openTracking: boolean;
  /** Active saved segments a campaign can target. */
  savedSegments?: { id: number; name: string; memberCount: number; lastCalculatedAt: string | null }[];
}

export interface Estimate {
  matching: number;
  channels: Partial<Record<Channel, number>>;
  messages: number;
  excluded: Partial<Record<Channel, number>>;
  capped: boolean;
}

export interface CampaignInput {
  name: string;
  description: string;
  kind: string;
  channels: Channel[];
  audience: Audience;
  content: CampaignContent;
  couponCode: string;
  startsAt: string | null;
  endsAt: string | null;
}

export const listCampaigns = (filters: { status?: string; q?: string; page?: number; pageSize?: number }) =>
  apiGet<Paged<Campaign> & { counts: Record<string, number> }>(`/admin/campaigns${query(filters)}`, ADMIN);
export const getCampaignOptions = () => apiGet<CampaignOptions>("/admin/campaigns/options", ADMIN);
export const estimateAudience = (audience: Audience, channels: Channel[]) =>
  apiPost<Estimate>("/admin/campaigns/estimate", { audience, channels }, ADMIN);
export const getCampaign = (id: number) => apiGet<Campaign>(`/admin/campaigns/${id}`, ADMIN);
export const createCampaign = (input: CampaignInput) => apiPost<Campaign>("/admin/campaigns", input, ADMIN);
export const updateCampaign = (id: number, input: CampaignInput) => apiPut<Campaign>(`/admin/campaigns/${id}`, input, ADMIN);
export const deleteCampaign = (id: number) => apiDelete<void>(`/admin/campaigns/${id}`, ADMIN);
export const duplicateCampaign = (id: number) => apiPost<Campaign>(`/admin/campaigns/${id}/duplicate`, {}, ADMIN);
export const previewCampaign = (id: number) =>
  apiGet<Partial<Record<Channel, Record<string, unknown>>>>(`/admin/campaigns/${id}/preview`, ADMIN);
export const testCampaign = (id: number, email: string, phone: string) =>
  apiPost<{ sent: { channel: string; to: string }[] }>(`/admin/campaigns/${id}/test`, { email, phone }, ADMIN);
export const launchCampaign = (id: number, confirmMessages: number, sendAt: string | null) =>
  apiPost<Campaign>(`/admin/campaigns/${id}/launch`, { confirmMessages, sendAt }, ADMIN);
export const cancelCampaign = (id: number) => apiPost<Campaign>(`/admin/campaigns/${id}/cancel`, {}, ADMIN);

export interface RecipientRow {
  id: number;
  customer: { id: string; name: string };
  channel: Channel;
  status: string;
  recipient: string;
  error: string;
  openedAt: string | null;
  clickedAt: string | null;
  unsubscribedAt: string | null;
  repliedAt: string | null;
  createdAt: string;
}

export const listRecipients = (id: number, filters: { channel?: string; status?: string; page?: number }) =>
  apiGet<Paged<RecipientRow>>(`/admin/campaigns/${id}/recipients${query(filters)}`, ADMIN);

/* ------------------------------------------------------------------- backups */

export interface BackupRow {
  id: number;
  reference: string;
  trigger: string;
  tier: string;
  status: "running" | "succeeded" | "failed" | "deleted";
  databaseName: string;
  storage: string;
  location: string;
  sizeBytes: number;
  checksum: string;
  encrypted: boolean;
  tables: number;
  rows: number;
  verifiedAt: string | null;
  error: string;
  startedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  durationSeconds: number | null;
}

export interface BackupSettings {
  enabled: boolean;
  frequency: "6h" | "12h" | "daily" | "weekly";
  hour: number;
  weekday: number;
  keepDailyDays: number;
  keepWeeklyWeeks: number;
  keepManual: number;
}

export interface BackupsPage extends Paged<BackupRow> {
  settings: BackupSettings;
  lastSuccess: BackupRow | null;
  lastFailure: BackupRow | null;
  running: BackupRow | null;
  nextRun: string | null;
  kept: number;
  keptBytes: number;
  storage: { storage: string; location: string; freeBytes: number | null };
  storageProblem: string;
  encrypted: boolean;
  warnings: string[];
  counts: Record<string, number>;
}

export const getBackups = (filters: { status?: string; page?: number; pageSize?: number }) =>
  apiGet<BackupsPage>(`/admin/backups${query(filters)}`, ADMIN);
export const saveBackupSettings = (settings: BackupSettings) => apiPut<BackupSettings>("/admin/backups/settings", settings, ADMIN);
export const runBackup = () => apiPost<BackupRow>("/admin/backups/run", {}, ADMIN);
export const backupDownloadLink = (id: number) =>
  apiPost<{ url: string; expiresIn: number; fileName: string }>(`/admin/backups/${id}/download`, {}, ADMIN);
