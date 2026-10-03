import { Badge } from "@/components/admin/views/operations/shared";
import type { LabelStatus, PackingPriority, PackingStatus } from "@/types/packing";
import { LABEL_STATUS_LABELS, PACKING_STATUS_LABELS, PRIORITY_LABELS } from "@/types/packing";

const STATUS_TONE: Record<PackingStatus, "green" | "amber" | "red" | "grey"> = {
  pending: "grey",
  picking: "amber",
  picked: "amber",
  packing: "amber",
  packed: "green",
  "ready-to-ship": "green",
  cancelled: "red",
};

export function PackingStatusBadge({ status, label }: { status: PackingStatus; label?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "grey"}>{label || PACKING_STATUS_LABELS[status] || status}</Badge>;
}

export function PriorityBadge({ priority }: { priority: PackingPriority }) {
  if (priority === "normal") return <span className="text-admin-muted">Normal</span>;
  return <Badge tone={priority === "urgent" ? "red" : "amber"}>{PRIORITY_LABELS[priority]}</Badge>;
}

const LABEL_TONE: Record<LabelStatus, "green" | "amber" | "red" | "grey"> = {
  "not-generated": "grey",
  generating: "amber",
  generated: "green",
  regenerated: "green",
  failed: "red",
  cancelled: "grey",
};

export function LabelStatusBadge({ status }: { status: LabelStatus }) {
  return <Badge tone={LABEL_TONE[status] ?? "grey"}>{LABEL_STATUS_LABELS[status] ?? status}</Badge>;
}

/** "3.5 h" / "2 d 4 h": how long an order has waited. */
export function agingLabel(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${Math.round(hours - days * 24)} h`;
}

/** Grams to "1.25 kg" / "450 g". */
export function weightLabel(grams: number | null | undefined): string {
  if (!grams) return "—";
  return grams >= 1000 ? `${(grams / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} kg` : `${grams} g`;
}

export function dimensionsLabel(l: number | null, w: number | null, h: number | null): string {
  if (l == null || w == null || h == null) return "—";
  return `${l} × ${w} × ${h} cm`;
}
