/**
 * Formatting shared by the customer's support pages and the support desk:
 * times in the store's clock, the SLA in words, and which tone each status
 * takes. Labels for statuses come from the API; only presentation lives here.
 */

import type { SlaState, TicketPriority, TicketStatus } from "@/services/supportService";

import { STORE_TIME_ZONE } from "@/lib/utils/format";

/** A zone-less server timestamp, read as the UTC it is. */
export function toDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  const marked = /T\d{2}:\d{2}/.test(input) && !/(Z|[+-]\d{2}:?\d{2})$/.test(input) ? `${input}Z` : input;
  const date = new Date(marked);
  return Number.isNaN(date.getTime()) ? null : date;
}

const TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: STORE_TIME_ZONE });
const DAY = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: STORE_TIME_ZONE,
});
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TIME_ZONE });

/** "10:24 am". */
export function formatTime(input: string | null | undefined): string {
  const date = toDate(input);
  return date ? TIME.format(date) : "";
}

/** "12 Sept 2026, 10:24 am". */
export function formatDateTime(input: string | null | undefined): string {
  const date = toDate(input);
  return date ? `${DAY.format(date)}, ${TIME.format(date)}` : "";
}

/** The calendar day in the store's clock, for grouping a conversation. */
export function dayKey(input: string | null | undefined): string {
  const date = toDate(input);
  return date ? DAY_KEY.format(date) : "";
}

/** "Today", "Yesterday" or the date. */
export function dayLabel(input: string | null | undefined): string {
  const date = toDate(input);
  if (!date) return "";
  const today = DAY_KEY.format(new Date());
  const yesterday = DAY_KEY.format(new Date(Date.now() - 86_400_000));
  const key = DAY_KEY.format(date);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return DAY.format(date);
}

/** "just now", "5 min ago", "3 h ago", or the date. */
export function formatAgo(input: string | null | undefined): string {
  const date = toDate(input);
  if (!date) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return DAY.format(date);
}

/** 84 → "1h 24m"; 2900 → "2d 0h". */
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.abs(Math.round(totalMinutes));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type SlaTone = "good" | "warning" | "critical" | "neutral" | "info";

/** The SLA as a short phrase and a tone — "1h 24m left", "Breached 3h ago". */
export function slaSummary(sla: SlaState): { text: string; tone: SlaTone } {
  const left = sla.minutesLeft;
  switch (sla.state) {
    case "breached":
      return { text: left !== null ? `Breached ${formatDuration(left)} ago` : "SLA breached", tone: "critical" };
    case "due-soon":
      return { text: `Due soon · ${formatDuration(left ?? 0)} left`, tone: "warning" };
    case "on-track":
      return { text: `${formatDuration(left ?? 0)} left`, tone: "good" };
    case "paused":
      return { text: "Paused — waiting on customer", tone: "info" };
    case "met":
      return { text: "Met", tone: "good" };
    default:
      return { text: "No target", tone: "neutral" };
  }
}

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/** Staff status → the portal's status palette. */
export const STATUS_TONES: Record<TicketStatus, "good" | "warning" | "serious" | "critical" | "neutral" | "info"> = {
  submitted: "warning",
  triaged: "warning",
  assigned: "info",
  acknowledged: "info",
  "in-progress": "info",
  "waiting-customer": "neutral",
  "waiting-internal": "serious",
  escalated: "critical",
  resolved: "good",
  closed: "neutral",
  reopened: "warning",
};

export const PRIORITY_TONES: Record<TicketPriority, "good" | "warning" | "serious" | "critical" | "neutral" | "info"> = {
  low: "neutral",
  medium: "info",
  high: "serious",
  urgent: "critical",
};

/** File size for people: "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The files the server accepts, for a file input's `accept`. */
export const ACCEPTED_FILES =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,.txt,.log,.csv,video/mp4,video/webm,video/quicktime";

const ACCEPTED_TYPES = new Set(ACCEPTED_FILES.split(",").filter((entry) => !entry.startsWith(".")));
const VIDEO = /^video\//;

/**
 * Check files before sending — the server checks again, by content. Returns
 * the first problem in words, or null.
 */
export function checkFiles(
  files: File[],
  limits: { maxFiles: number; maxSizeMb: number; maxVideoSizeMb: number },
): string | null {
  if (files.length > limits.maxFiles) return `Attach up to ${limits.maxFiles} files.`;
  for (const file of files) {
    const textByName = /\.(txt|log|csv)$/i.test(file.name);
    if (!ACCEPTED_TYPES.has(file.type) && !textByName) {
      return `${file.name} isn't a type we accept. Use an image, PDF, text file or short video.`;
    }
    const limit = VIDEO.test(file.type) ? limits.maxVideoSizeMb : limits.maxSizeMb;
    if (file.size > limit * 1024 * 1024) return `${file.name} is larger than ${limit} MB.`;
  }
  return null;
}
