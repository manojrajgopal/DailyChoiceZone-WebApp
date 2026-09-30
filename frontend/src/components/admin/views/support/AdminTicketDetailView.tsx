"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  GitMerge,
  Link2,
  Loader2,
  RotateCcw,
  Unlink,
  UserPlus,
  XCircle,
} from "lucide-react";

import {
  deskAttachmentLink,
  escalateDeskTicket,
  getDeskLookups,
  getDeskTicket,
  linkDeskTicket,
  markDeskRead,
  mergeDeskTicket,
  postDeskMessage,
  reason,
  sendDeskTyping,
  setDeskAssignment,
  setDeskPriority,
  setDeskStage,
  setDeskStatus,
  unlinkDeskTicket,
  type StaffTicket,
} from "@/services/supportService";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Composer, ConversationThread } from "@/components/support/Conversation";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { usePoll } from "@/hooks/usePoll";
import { ApiError } from "@/services/api/client";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { formatDateTime, formatAgo } from "@/lib/support/format";
import { toast } from "@/store/toastStore";

import { NoSupportAccess, PriorityBadge, SlaChip, TicketStatusBadge, useSupportMe } from "./SupportDeskParts";

const LIMITS = { maxFiles: 5, maxSizeMb: 10, maxVideoSizeMb: 25 };

/** How each audit entry reads in the timeline. */
function describe(event: StaffTicket["events"][number]): string {
  switch (event.kind) {
    case "created":
      return `Raised the request${event.note ? ` (${event.note})` : ""}`;
    case "status":
      return `Status: ${event.from || "—"} → ${event.to}${event.note ? ` — ${event.note}` : ""}`;
    case "assigned":
      return `Assigned to ${event.to}`;
    case "reassigned":
      return `Reassigned from ${event.from} to ${event.to}`;
    case "team":
      return `Team: ${event.from || "none"} → ${event.to || "none"}`;
    case "priority":
      return `Priority: ${event.from} → ${event.to}`;
    case "stage":
      return `Feature stage: ${event.from || "—"} → ${event.to}`;
    case "note":
      return "Added an internal note";
    case "reply":
      return "Replied to the customer";
    case "escalated":
      return `Escalated to ${event.to}${event.note ? ` — ${event.note}` : ""}`;
    case "merged":
      return `Merged into ${event.to}`;
    case "merged-in":
      return `${event.from} was merged into this ticket`;
    case "linked":
      return `Linked to ${event.to}`;
    case "unlinked":
      return `Unlinked from ${event.to}`;
    case "sla-warning":
      return "SLA warning: due soon";
    case "sla-breached":
      return "SLA breached";
    case "feedback":
      return `Customer rated the help ${event.to}`;
    case "customer-choice":
      return `Customer asked for ${event.to}`;
    default:
      return `${event.kind}${event.to ? `: ${event.to}` : ""}`;
  }
}

/**
 * One ticket, for the people working it: the conversation and internal
 * notes, who the customer is and what they bought, where the ticket stands
 * against its SLA, and every action — assign, reprioritise, move it on,
 * escalate, merge, link. The status menu offers only the moves the API
 * allows from where the ticket is.
 */
export function AdminTicketDetailView() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const me = useSupportMe();
  const [ticket, setTicket] = useState<StaffTicket | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tab, setTab] = useState<"conversation" | "activity">("conversation");
  const [dialog, setDialog] = useState<null | "escalate" | "merge" | "link">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const readFor = useRef<number>(0);

  const lookups = useAdminResource(() => getDeskLookups(), [], { enabled: Boolean(me.data?.canWork) });

  const load = useCallback(
    async (quiet = false) => {
      if (!id) return;
      try {
        const next = await getDeskTicket(id);
        setTicket(next);
        setError(null);
        const newest = next.messages[next.messages.length - 1]?.id ?? 0;
        if (next.unread > 0 && readFor.current !== newest) {
          readFor.current = newest;
          void markDeskRead(id).catch(() => undefined);
        }
      } catch (cause) {
        if (!quiet) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
    [id],
  );

  useEffect(() => {
    if (me.data?.canWork) void load();
  }, [load, me.data?.canWork]);
  usePoll(() => void load(true), ticket?.channel === "chat" ? 5000 : 12000, Boolean(ticket) && dialog === null);

  const fetchLink = useCallback((attachmentId: number) => deskAttachmentLink(id, attachmentId), [id]);

  /** Run an action that returns the updated ticket. */
  const act = async (label: string, run: () => Promise<StaffTicket>, success?: string) => {
    setBusy(label);
    try {
      const next = await run();
      setTicket(next);
      if (success) toast.success(success);
      return true;
    } catch (cause) {
      toast.error(reason(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (me.isLoading || (!ticket && !error && me.data?.canWork)) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
      </div>
    );
  }
  if (!me.data?.canWork) return <NoSupportAccess />;
  if (error || !ticket) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div>
        <AdminPageHeader
          title={missing ? "Ticket not found" : "The ticket didn't load"}
          breadcrumbs={[{ label: "Support", href: "/admin/support" }, { label: id || "Ticket" }]}
        />
        <AdminCard>
          <div className="py-8 text-center">
            <p className="text-sm text-admin-muted">
              {missing ? "It doesn't exist, or it belongs to a team you don't work with." : "Please try again."}
            </p>
            {!missing ? (
              <AdminButton size="sm" className="mt-3" onClick={() => void load()}>
                Try again
              </AdminButton>
            ) : null}
          </div>
        </AdminCard>
      </div>
    );
  }

  const allowed = new Set(ticket.transitions.map((entry) => entry.value));
  const canned = lookups.data?.canned ?? [];
  const merged = Boolean(ticket.mergedInto);
  const path = [ticket.category, ticket.subcategory, ticket.issue].filter(Boolean).join(" › ");

  return (
    <div>
      <AdminPageHeader
        title={ticket.subject}
        description={`${ticket.number} · ${path || "No category"} · raised ${formatDateTime(ticket.createdAt)}`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Support", href: "/admin/support" },
          { label: ticket.number },
        ]}
        actions={
          merged ? null : (
            <>
              {allowed.has("resolved") ? (
                <AdminButton
                  size="sm"
                  variant="primary"
                  loading={busy === "resolved"}
                  onClick={() => void act("resolved", () => setDeskStatus(ticket.id, "resolved"), "Marked resolved.")}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Resolve
                </AdminButton>
              ) : null}
              {allowed.has("closed") ? (
                <AdminButton size="sm" loading={busy === "closed"} onClick={() => void act("closed", () => setDeskStatus(ticket.id, "closed"), "Closed.")}>
                  <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Close
                </AdminButton>
              ) : null}
              {allowed.has("reopened") ? (
                <AdminButton size="sm" loading={busy === "reopened"} onClick={() => void act("reopened", () => setDeskStatus(ticket.id, "reopened"), "Reopened.")}>
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Reopen
                </AdminButton>
              ) : null}
              <AdminButton size="sm" onClick={() => setDialog("escalate")}>
                <ArrowUpCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Escalate
              </AdminButton>
              <AdminButton size="sm" onClick={() => setDialog("link")}>
                <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Link
              </AdminButton>
              <AdminButton size="sm" onClick={() => setDialog("merge")}>
                <GitMerge className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Merge
              </AdminButton>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={ticket.status} label={ticket.statusLabel} />
        <PriorityBadge priority={ticket.priority} />
        <StatusBadge tone="neutral">{ticket.channel === "chat" ? "Live chat" : "Contact form"}</StatusBadge>
        {ticket.escalationLevel > 0 ? <StatusBadge tone="critical">Escalation level {ticket.escalationLevel}</StatusBadge> : null}
        {ticket.featureStage ? <StatusBadge tone="info">Feature: {ticket.featureStageLabel}</StatusBadge> : null}
        <SlaChip sla={ticket.sla} className="ml-1" />
      </div>

      {merged ? (
        <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-raised px-4 py-3 text-sm text-admin-ink">
          This ticket was merged. The conversation continues in{" "}
          {ticket.links
            .filter((link) => link.kind === "merged-into")
            .map((link) => (
              <Link key={link.id} href={`/admin/support/ticket?id=${encodeURIComponent(link.id)}`} className="font-medium text-copper-700 hover:underline">
                {link.number}
              </Link>
            ))}
          .
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        {/* ------------------------------------------------------------ main */}
        <div className="min-w-0">
          <div role="tablist" aria-label="Ticket sections" className="mb-3 flex gap-5 border-b border-admin-border">
            {(
              [
                ["conversation", `Conversation (${ticket.messages.filter((m) => m.kind !== "system").length})`],
                ["activity", `Activity (${ticket.events.length})`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "-mb-px border-b-2 pb-2 text-sm font-medium transition-colors",
                  tab === value ? "border-copper-600 text-admin-ink" : "border-transparent text-admin-muted hover:text-admin-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "conversation" ? (
            <section className="flex flex-col overflow-hidden rounded-[3px] border border-admin-border bg-admin-plane" aria-label="Conversation">
              <ConversationThread
                messages={ticket.messages}
                audience="staff"
                variant="admin"
                typing={ticket.customerTyping ? `${ticket.customer.name} is typing…` : null}
                attachmentScope={`d:${ticket.id}`}
                fetchLink={fetchLink}
                className="max-h-[min(40rem,62dvh)] min-h-[18rem]"
              />
              {merged ? null : (
                <Composer
                  variant="admin"
                  limits={LIMITS}
                  attachmentsEnabled={ticket.attachmentsEnabled}
                  allowInternal
                  statuses={ticket.status === "closed" ? [] : ticket.transitions}
                  canned={canned}
                  enterToSend={ticket.channel === "chat"}
                  disabled={false}
                  placeholder={ticket.status === "closed" ? "Reopen the ticket to reply — or add an internal note" : "Reply to the customer…"}
                  onTyping={() => void sendDeskTyping(ticket.id).catch(() => undefined)}
                  onSend={(body, files, extra) =>
                    act("message", () => postDeskMessage(ticket.id, { body, internal: extra.internal, status: extra.status }, files),
                      extra.internal ? "Note added." : undefined)
                  }
                />
              )}
            </section>
          ) : (
            <AdminCard padded={false}>
              <ol className="divide-y divide-admin-border">
                {[...ticket.events].reverse().map((event) => (
                  <li key={event.id} className="flex gap-3 px-4 py-3">
                    <span
                      className={cn(
                        "mt-1.5 h-2 w-2 shrink-0 rounded-pill",
                        event.actorKind === "customer" ? "bg-copper-500" : event.actorKind === "system" ? "bg-admin-faint" : "bg-[#2a78d6]",
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-[0.8125rem] text-admin-ink">{describe(event)}</p>
                      <p className="mt-0.5 text-[0.6875rem] text-admin-muted">
                        {event.actor || (event.actorKind === "system" ? "System" : "—")} · {formatDateTime(event.at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </AdminCard>
          )}

          {ticket.details.length > 0 || ticket.description ? (
            <AdminCard title="What the customer told us" className="mt-4">
              {ticket.details.length > 0 ? (
                <dl className="grid gap-3 sm:grid-cols-2">
                  {ticket.details.map((detail) => (
                    <div key={detail.key} className={cn(detail.value.length > 80 && "sm:col-span-2")}>
                      <dt className="text-[0.6875rem] text-admin-muted">{detail.label}</dt>
                      <dd className="mt-0.5 whitespace-pre-wrap break-words text-[0.8125rem] text-admin-ink">{detail.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-xs text-admin-muted">No extra details — see the first message.</p>
              )}
            </AdminCard>
          ) : null}
        </div>

        {/* ------------------------------------------------------------ side */}
        <aside className="flex flex-col gap-4">
          {/* Keyed on the assignment, so a change made elsewhere resets the menus. */}
          <PropertiesCard
            key={`${ticket.teamId ?? ""}-${ticket.agentId ?? ""}`}
            ticket={ticket}
            lookups={lookups.data}
            busy={busy}
            act={act}
            myAgentId={me.data.agent?.id ?? null}
            merged={merged}
          />

          <AdminCard title="SLA">
            <dl className="flex flex-col gap-2 text-xs">
              <Row label="State">
                <SlaChip sla={ticket.sla} />
              </Row>
              <Row label="First reply due">{ticket.responseDueAt ? formatDateTime(ticket.responseDueAt) : "—"}</Row>
              <Row label="First reply">{ticket.firstResponseAt ? formatDateTime(ticket.firstResponseAt) : "Not yet"}</Row>
              <Row label="Resolve by">{ticket.sla.dueAt ? formatDateTime(ticket.sla.dueAt) : "—"}</Row>
              {ticket.resolvedAt ? <Row label="Resolved">{formatDateTime(ticket.resolvedAt)}</Row> : null}
              {ticket.reopenedCount ? <Row label="Reopened">{ticket.reopenedCount}×</Row> : null}
            </dl>
          </AdminCard>

          <AdminCard
            title="Customer"
            action={
              ticket.customer.id ? (
                <Link href={`/admin/customers/detail?id=${encodeURIComponent(ticket.customer.id)}`} className="inline-flex items-center gap-1 text-xs text-copper-700 hover:underline">
                  Profile <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              ) : (
                <StatusBadge tone="neutral">Guest</StatusBadge>
              )
            }
          >
            <p className="text-sm font-medium text-admin-ink">{ticket.customer.name}</p>
            <p className="mt-0.5 break-all text-xs text-admin-muted">{ticket.customer.email}</p>
            {ticket.customer.phone ? <p className="text-xs text-admin-muted">{ticket.customer.phone}</p> : null}
            {ticket.customer.id ? (
              <p className="mt-2 text-xs text-admin-muted">
                {ticket.customer.orders} {ticket.customer.orders === 1 ? "order" : "orders"}
                {ticket.customer.since ? ` · customer since ${formatDate(ticket.customer.since)}` : ""}
              </p>
            ) : null}
            <Link
              href={`/admin/support?view=all&q=${encodeURIComponent(ticket.customer.email)}`}
              className="mt-2 inline-block text-xs text-copper-700 hover:underline"
            >
              Other requests from this customer
            </Link>
          </AdminCard>

          {ticket.order ? (
            <AdminCard
              title="Order"
              action={
                <Link href={`/admin/orders/detail?id=${encodeURIComponent(ticket.order.id)}`} className="inline-flex items-center gap-1 text-xs text-copper-700 hover:underline">
                  Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              }
            >
              <p className="text-sm font-medium text-admin-ink">{ticket.order.number}</p>
              <p className="mt-0.5 text-xs text-admin-muted">
                {formatDate(ticket.order.placedAt)} · {formatPrice(ticket.order.total)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusBadge tone="info">{ticket.order.status}</StatusBadge>
                <StatusBadge tone={ticket.order.paymentStatus === "paid" ? "good" : "warning"}>
                  {ticket.order.paymentStatus} · {ticket.order.paymentMethod}
                </StatusBadge>
              </div>
              <ul className="mt-3 flex flex-col gap-1">
                {ticket.order.items.map((item, index) => (
                  <li key={`${item.name}-${index}`} className="flex justify-between gap-2 text-xs text-admin-ink">
                    <span className="truncate">
                      {item.quantity} × {item.name}
                      {item.size ? ` · ${item.size}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums text-admin-muted">{formatPrice(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>
            </AdminCard>
          ) : null}

          {ticket.product ? (
            <AdminCard title="Product">
              <p className="text-sm font-medium text-admin-ink">{ticket.product.name}</p>
              <p className="mt-0.5 text-xs text-admin-muted">
                {ticket.product.brand} · {formatPrice(ticket.product.price)}
              </p>
            </AdminCard>
          ) : null}

          {ticket.membership ? (
            <AdminCard title="Membership">
              <p className="text-sm font-medium text-admin-ink">{ticket.membership.plan}</p>
              <p className="mt-0.5 text-xs text-admin-muted">
                {ticket.membership.status} · {formatDate(ticket.membership.startsAt)} – {formatDate(ticket.membership.endsAt)}
              </p>
            </AdminCard>
          ) : null}

          <AdminCard title="Linked tickets">
            {ticket.links.length === 0 ? (
              <p className="text-xs text-admin-muted">None.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {ticket.links.map((link) => (
                  <li key={`${link.kind}-${link.id}`} className="flex items-start justify-between gap-2">
                    <Link href={`/admin/support/ticket?id=${encodeURIComponent(link.id)}`} className="min-w-0 text-xs hover:text-copper-700">
                      <span className="font-medium text-admin-ink">{link.number}</span>
                      <span className="text-admin-muted">
                        {" "}
                        · {link.kind === "related" ? "related" : link.kind === "merged-into" ? "merged into" : "merged from"} · {link.statusLabel}
                      </span>
                      <span className="block truncate text-admin-muted">{link.subject}</span>
                    </Link>
                    {link.kind === "related" && !merged ? (
                      <button
                        type="button"
                        onClick={() => void act("unlink", () => unlinkDeskTicket(ticket.id, link.id), "Unlinked.")}
                        className="shrink-0 rounded-[3px] p-1 text-admin-muted hover:bg-admin-raised hover:text-admin-ink"
                        aria-label={`Unlink ${link.number}`}
                      >
                        <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>

          {ticket.feedback ? (
            <AdminCard title="Customer rating">
              <p className="text-lg text-[#b07500]" aria-label={`${ticket.feedback.rating} out of 5`}>
                {"★".repeat(ticket.feedback.rating)}
                <span className="text-admin-border-strong">{"★".repeat(5 - ticket.feedback.rating)}</span>
              </p>
              {ticket.feedback.comment ? <p className="mt-1 text-xs text-admin-ink">&ldquo;{ticket.feedback.comment}&rdquo;</p> : null}
              <p className="mt-1 text-[0.6875rem] text-admin-muted">{formatAgo(ticket.feedback.at)}</p>
            </AdminCard>
          ) : null}
        </aside>
      </div>

      <EscalateDialog
        open={dialog === "escalate"}
        onOpenChange={(open) => setDialog(open ? "escalate" : null)}
        onSubmit={async (why) => {
          if (await act("escalate", () => escalateDeskTicket(ticket.id, why), "Escalated — the next people up have been told.")) setDialog(null);
        }}
      />
      <TicketRefDialog
        open={dialog === "link"}
        onOpenChange={(open) => setDialog(open ? "link" : null)}
        title="Link a related ticket"
        description="Linking keeps both tickets open and shows each on the other."
        confirmLabel="Link"
        onSubmit={async (other) => {
          if (await act("link", () => linkDeskTicket(ticket.id, other), "Linked.")) setDialog(null);
        }}
      />
      <MergeDialog
        open={dialog === "merge"}
        onOpenChange={(open) => setDialog(open ? "merge" : null)}
        number={ticket.number}
        onSubmit={async (other) => {
          setBusy("merge");
          try {
            const target = await mergeDeskTicket(ticket.id, other);
            toast.success(`Merged into ${target.number}.`);
            setDialog(null);
            router.push(`/admin/support/ticket?id=${encodeURIComponent(target.id)}`);
          } catch (cause) {
            toast.error(reason(cause));
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-admin-muted">{label}</dt>
      <dd className="text-right text-admin-ink">{children}</dd>
    </div>
  );
}

/* --------------------------------------------------------------- properties */

function PropertiesCard({
  ticket,
  lookups,
  busy,
  act,
  myAgentId,
  merged,
}: {
  ticket: StaffTicket;
  lookups: Awaited<ReturnType<typeof getDeskLookups>> | null;
  busy: string | null;
  act: (label: string, run: () => Promise<StaffTicket>, success?: string) => Promise<boolean>;
  myAgentId: number | null;
  merged: boolean;
}) {
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [teamId, setTeamId] = useState(ticket.teamId ? String(ticket.teamId) : "");
  const [agentId, setAgentId] = useState(ticket.agentId ? String(ticket.agentId) : "");

  const agents = (lookups?.agents ?? []).filter((agent) => agent.active && (!teamId || agent.teamId === Number(teamId)));
  const assignmentChanged = teamId !== (ticket.teamId ? String(ticket.teamId) : "") || agentId !== (ticket.agentId ? String(ticket.agentId) : "");

  return (
    <AdminCard title="Ticket">
      <div className="flex flex-col gap-4">
        {/* Status: only what the lifecycle allows from here. */}
        <div className="flex flex-col gap-2">
          <AdminSelect
            label="Status"
            value={status}
            disabled={merged || ticket.transitions.length === 0}
            onChange={(event) => setStatus(event.target.value)}
            placeholder={`${ticket.statusLabel} (current)`}
            options={ticket.transitions}
            hint={ticket.transitions.length === 0 ? "No further moves from here." : undefined}
          />
          {status ? (
            <>
              <AdminInput label="Note (optional)" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
              <div className="flex gap-2">
                <AdminButton
                  size="sm"
                  variant="primary"
                  loading={busy === "status"}
                  onClick={async () => {
                    if (await act("status", () => setDeskStatus(ticket.id, status, note), "Status updated.")) {
                      setStatus("");
                      setNote("");
                    }
                  }}
                >
                  Update status
                </AdminButton>
                <AdminButton size="sm" variant="ghost" onClick={() => setStatus("")}>
                  Cancel
                </AdminButton>
              </div>
            </>
          ) : null}
        </div>

        <AdminSelect
          label="Priority"
          value={ticket.priority}
          disabled={merged || busy === "priority"}
          onChange={(event) => void act("priority", () => setDeskPriority(ticket.id, event.target.value), "Priority changed — the SLA target moved with it.")}
          options={(lookups?.priorities ?? [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "urgent", label: "Urgent" },
          ]).map((entry) => ({ value: entry.value, label: entry.label }))}
        />

        {ticket.contactType === "feature" ? (
          <AdminSelect
            label="Feature request stage"
            value={ticket.featureStage}
            disabled={merged || busy === "stage"}
            onChange={(event) => void act("stage", () => setDeskStage(ticket.id, event.target.value), "Stage updated — the customer has been told.")}
            options={lookups?.featureStages ?? []}
          />
        ) : null}

        <div className="flex flex-col gap-2 border-t border-admin-border pt-4">
          <AdminSelect
            label="Team"
            value={teamId}
            disabled={merged}
            onChange={(event) => {
              setTeamId(event.target.value);
              setAgentId("");
            }}
            placeholder="No team"
            options={(lookups?.teams ?? []).filter((team) => team.active || String(team.id) === teamId).map((team) => ({ value: String(team.id), label: team.name }))}
          />
          <AdminSelect
            label="Agent"
            value={agentId}
            disabled={merged}
            onChange={(event) => setAgentId(event.target.value)}
            placeholder="Unassigned"
            options={agents.map((agent) => ({ value: String(agent.id), label: `${agent.name}${agent.available ? "" : " (away)"}` }))}
          />
          <div className="flex flex-wrap gap-2">
            {assignmentChanged ? (
              <AdminButton
                size="sm"
                variant="primary"
                loading={busy === "assign"}
                onClick={() =>
                  void act(
                    "assign",
                    () => setDeskAssignment(ticket.id, teamId ? Number(teamId) : null, agentId ? Number(agentId) : null),
                    ticket.agentId ? "Reassigned." : "Assigned.",
                  )
                }
              >
                {ticket.agentId ? "Reassign" : "Assign"}
              </AdminButton>
            ) : null}
            {myAgentId && ticket.agentId !== myAgentId && !merged ? (
              <AdminButton
                size="sm"
                loading={busy === "take"}
                onClick={() => void act("take", () => setDeskAssignment(ticket.id, null, myAgentId), "It's yours.")}
              >
                <UserPlus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Assign to me
              </AdminButton>
            ) : null}
          </div>
          {ticket.agentCard?.email ? (
            <p className="text-[0.6875rem] text-admin-muted">
              {ticket.agentCard.name}
              {ticket.agentCard.role ? ` · ${ticket.agentCard.role}` : ""} · {ticket.agentCard.email}
            </p>
          ) : null}
        </div>
      </div>
    </AdminCard>
  );
}

/* ------------------------------------------------------------------ dialogs */

function EscalateDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Escalate this ticket" description="The team lead hears first; a second escalation reaches the admins." className="max-w-md">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (why.trim().length < 3) {
            setError("Say why it's being escalated.");
            return;
          }
          setSaving(true);
          await onSubmit(why.trim());
          setSaving(false);
          setWhy("");
        }}
      >
        <AdminTextarea
          label="Reason"
          rows={3}
          maxLength={300}
          value={why}
          error={error ?? undefined}
          onChange={(event) => {
            setWhy(event.target.value);
            setError(null);
          }}
          required
        />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="danger" loading={saving}>
            Escalate
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}

function TicketRefDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onSubmit: (other: string) => Promise<void>;
}) {
  const [other, setOther] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description} className="max-w-md">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!other.trim()) return;
          setSaving(true);
          await onSubmit(other.trim());
          setSaving(false);
          setOther("");
        }}
      >
        <AdminInput label="Ticket number" placeholder="DCZ-2026-000123" value={other} onChange={(event) => setOther(event.target.value)} required />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving} disabled={!other.trim()}>
            {confirmLabel}
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}

function MergeDialog({
  open,
  onOpenChange,
  number,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  number: string;
  onSubmit: (other: string) => Promise<void>;
}) {
  const [other, setOther] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <>
      <TicketRefDialog
        open={open && !confirming}
        onOpenChange={onOpenChange}
        title="Merge into another ticket"
        description={`${number} will be closed and point to the ticket you choose. Both keep their full history. Only tickets from the same customer can be merged.`}
        confirmLabel="Continue"
        onSubmit={async (value) => {
          setOther(value);
          setConfirming(true);
        }}
      />
      <ConfirmDialog
        open={open && confirming}
        onOpenChange={(next) => {
          if (!next) {
            setConfirming(false);
            onOpenChange(false);
          }
        }}
        title={`Merge ${number} into ${other}?`}
        message={`${number} will be closed, and the customer will be told the conversation continues in ${other}. This can't be undone.`}
        confirmLabel="Merge tickets"
        loading={saving}
        onConfirm={async () => {
          setSaving(true);
          await onSubmit(other);
          setSaving(false);
          setConfirming(false);
        }}
      />
    </>
  );
}
