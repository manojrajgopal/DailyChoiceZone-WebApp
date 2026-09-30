"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock, Loader2, MessageCircle, RotateCcw, Users } from "lucide-react";

import {
  closeMyTicket,
  customerAttachmentLink,
  getMyTicket,
  getSupportConfig,
  markTicketRead,
  rateMyTicket,
  reason,
  reopenMyTicket,
  replyToTicket,
  sendTyping,
  type CustomerTicket,
  type SupportCentreConfig,
} from "@/services/supportService";

import { ErrorState } from "@/components/common/States";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { usePoll } from "@/hooks/usePoll";
import { ApiError } from "@/services/api/client";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { formatDateTime } from "@/lib/support/format";
import { toast } from "@/store/toastStore";

import { Composer, ConversationThread } from "./Conversation";
import { CustomerStatusBadge, StarInput } from "./SupportParts";

const DEFAULT_LIMITS = { maxFiles: 5, maxSizeMb: 10, maxVideoSizeMb: 25 };

/**
 * One of the customer's requests: its conversation, where it stands, and
 * what they can do with it — reply, close it, reopen it, rate the help.
 *
 * Reached from the account (by account) or from an emailed link (by the
 * ticket's key). Either way the API decides what is visible; this view only
 * draws what comes back.
 */
export function CustomerTicketView({
  number,
  ticketKey,
  backHref,
}: {
  number: string;
  /** A guest's emailed key; null for a signed-in customer. */
  ticketKey: string | null;
  backHref?: string;
}) {
  const [ticket, setTicket] = useState<CustomerTicket | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [config, setConfig] = useState<SupportCentreConfig | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastSeen = useRef<number>(0);

  const load = useCallback(
    async (quiet = false) => {
      try {
        const next = await getMyTicket(number, ticketKey);
        setTicket(next);
        setError(null);
        // Whatever the team sent is read now that it is on screen.
        const newest = next.messages[next.messages.length - 1]?.id ?? 0;
        if (next.unread > 0 && newest !== lastSeen.current) {
          lastSeen.current = newest;
          void markTicketRead(number, ticketKey).catch(() => undefined);
        }
      } catch (cause) {
        if (!quiet) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
    [number, ticketKey],
  );

  useEffect(() => {
    void load();
    getSupportConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [load]);

  // A live chat refreshes quickly; an ordinary request more gently.
  const live = ticket?.channel === "chat" && ticket.status !== "closed" && ticket.status !== "resolved";
  usePoll(() => void load(true), live ? 4000 : 15000, ticket !== null && ticket.status !== "closed");

  const fetchLink = useCallback((id: number) => customerAttachmentLink(number, id, ticketKey), [number, ticketKey]);

  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <ErrorState
        title={missing ? "We couldn't find that request" : "We couldn't load your request"}
        description={
          missing
            ? "Check the link in your email, or sign in to the account you raised it from."
            : "Please check your connection and try again."
        }
        onRetry={missing ? undefined : () => void load()}
      />
    );
  }

  if (!ticket) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your request">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <Skeleton className="h-[28rem] w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const limits = config?.attachments ?? DEFAULT_LIMITS;
  const path = [ticket.category, ticket.subcategory, ticket.issue].filter(Boolean).join(" › ");

  const reply = async (body: string, files: File[]) => {
    try {
      setTicket(await replyToTicket(number, body, files, ticketKey));
      return true;
    } catch (cause) {
      toast.error(reason(cause, "Your message couldn't be sent. Please try again."));
      return false;
    }
  };

  const close = async () => {
    setBusy(true);
    try {
      setTicket(await closeMyTicket(number, ticketKey));
      toast.success("Your request is closed. Thank you!");
      setConfirmClose(false);
    } catch (cause) {
      toast.error(reason(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {backHref ? (
        <Link
          href={backHref}
          className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
          All requests
        </Link>
      ) : null}

      {/* ---------------------------------------------------------- summary */}
      <header className="rounded-card border border-ink-200 bg-shell p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label-wide text-ink-400">
              {ticket.channel === "chat" ? "Live chat" : "Request"} {ticket.number}
            </p>
            <h2 className="mt-1.5 font-display text-xl leading-snug text-ink sm:text-2xl">{ticket.subject}</h2>
            {path ? <p className="mt-1 text-sm text-ink-500">{path}</p> : null}
          </div>
          <CustomerStatusBadge status={ticket.status} label={ticket.statusLabel} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-ink-100 pt-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="label-wide text-ink-400">Priority</dt>
            <dd className="mt-1 text-ink-700">{ticket.priorityLabel}</dd>
          </div>
          <div>
            <dt className="label-wide text-ink-400">Raised</dt>
            <dd className="mt-1 text-ink-700">{formatDate(ticket.createdAt)}</dd>
          </div>
          <div>
            <dt className="label-wide text-ink-400">With</dt>
            <dd className="mt-1 flex items-center gap-1.5 text-ink-700">
              <Users className="h-3.5 w-3.5 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
              <span className="truncate">
                {ticket.agentCard ? ticket.agentCard.name : ticket.teamName ? `${ticket.teamName} team` : "Our team"}
              </span>
            </dd>
          </div>
          <div>
            <dt className="label-wide text-ink-400">{ticket.featureStage ? "Stage" : "Last update"}</dt>
            <dd className="mt-1 text-ink-700">
              {ticket.featureStage ? ticket.featureStageLabel : formatDateTime(ticket.updatedAt)}
            </dd>
          </div>
        </dl>

        {/* What the customer can expect — never the team's internal targets. */}
        {!ticket.firstResponseAt && ticket.responseDueAt && ticket.status !== "closed" && ticket.status !== "resolved" ? (
          <p className="mt-4 flex items-start gap-2 rounded-card bg-cream-deep px-3 py-2.5 text-xs leading-relaxed text-ink-700">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
            We aim to reply by {formatDateTime(ticket.responseDueAt)}.
          </p>
        ) : null}
        {ticket.status === "waiting-customer" ? (
          <p className="mt-4 flex items-start gap-2 rounded-card bg-clay-500/10 px-3 py-2.5 text-xs leading-relaxed text-ink-700">
            <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-clay-600" strokeWidth={1.5} aria-hidden="true" />
            We&rsquo;re waiting for your reply — answer below and we&rsquo;ll pick it straight back up.
          </p>
        ) : null}
        {ticket.mergedInto ? (
          <p className="mt-4 rounded-card bg-cream-deep px-3 py-2.5 text-xs leading-relaxed text-ink-700">
            This request was combined with{" "}
            {ticketKey ? (
              <span className="font-medium">{ticket.mergedInto}</span>
            ) : (
              <Link
                href={`/account/ticket?number=${encodeURIComponent(ticket.mergedInto)}`}
                className="font-medium text-copper-700 underline underline-offset-2"
              >
                {ticket.mergedInto}
              </Link>
            )}
            , where we&rsquo;ll continue.
          </p>
        ) : null}
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* ------------------------------------------------------ conversation */}
        <section aria-label="Conversation" className="flex min-w-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-cream">
          <ConversationThread
            messages={ticket.messages}
            audience="customer"
            variant="store"
            typing={ticket.agentTyping ? `${ticket.agentCard?.name ?? "Our team"} is typing…` : null}
            attachmentScope={`c:${ticket.number}`}
            fetchLink={fetchLink}
            className="max-h-[min(34rem,65dvh)] min-h-[16rem]"
          />

          {ticket.canReply ? (
            <Composer
              variant="store"
              limits={limits}
              attachmentsEnabled={ticket.attachmentsEnabled}
              onSend={(body, files) => reply(body, files)}
              onTyping={() => void sendTyping(number, ticketKey).catch(() => undefined)}
              enterToSend={ticket.channel === "chat"}
              placeholder={ticket.status === "resolved" ? "Still need help? Reply to reopen your request…" : "Write your reply…"}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-200 bg-shell px-4 py-3.5">
              <p className="text-sm text-ink-500">
                {ticket.mergedInto
                  ? "This conversation continues in another request."
                  : ticket.canReopen
                    ? `This request is closed. You can reopen it until ${formatDate(ticket.reopenUntil ?? ticket.updatedAt)}.`
                    : "This request is closed. If you still need help, please raise a new one."}
              </p>
              {ticket.canReopen ? (
                <Button size="sm" variant="outline" onClick={() => setReopening(true)}>
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Reopen
                </Button>
              ) : !ticket.mergedInto ? (
                <Link href="/contact" className="text-sm font-medium text-copper-700 underline underline-offset-2 hover:text-ink">
                  Raise a new request
                </Link>
              ) : null}
            </div>
          )}
        </section>

        {/* ----------------------------------------------------------- side */}
        <aside className="flex flex-col gap-4">
          {ticket.canRate ? <RateCard ticket={ticket} ticketKey={ticketKey} onRated={setTicket} /> : null}
          {ticket.feedback ? (
            <div className="rounded-card border border-ink-200 bg-shell p-4">
              <p className="label-wide text-ink-400">Your rating</p>
              <p className="mt-2 text-lg text-copper-600" aria-label={`${ticket.feedback.rating} out of 5 stars`}>
                {"★".repeat(ticket.feedback.rating)}
                <span className="text-ink-200">{"★".repeat(5 - ticket.feedback.rating)}</span>
              </p>
              {ticket.feedback.comment ? <p className="mt-1.5 text-sm text-ink-700">{ticket.feedback.comment}</p> : null}
            </div>
          ) : null}

          {ticket.canClose && ticket.status !== "resolved" ? (
            <div className="rounded-card border border-ink-200 bg-shell p-4">
              <p className="text-sm font-medium text-ink">Sorted already?</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                If you don&rsquo;t need anything more, you can close this request.
              </p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setConfirmClose(true)}>
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Close request
              </Button>
            </div>
          ) : null}
          {ticket.status === "resolved" ? (
            <div className="rounded-card border border-sage-100 bg-sage-100/40 p-4">
              <p className="text-sm font-medium text-ink">We&rsquo;ve marked this resolved</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">
                Reply if anything still isn&rsquo;t right, or confirm it&rsquo;s sorted.
              </p>
              <Button size="sm" className="mt-3" onClick={() => setConfirmClose(true)}>
                Yes, it&rsquo;s sorted
              </Button>
            </div>
          ) : null}

          {ticket.order ? (
            <div className="rounded-card border border-ink-200 bg-shell p-4">
              <p className="label-wide text-ink-400">Order</p>
              <Link
                href={`/account/order?number=${encodeURIComponent(ticket.order.number)}`}
                className="mt-1.5 block font-display text-base text-ink hover:text-copper-700"
              >
                {ticket.order.number}
              </Link>
              <p className="mt-0.5 text-xs text-ink-500">
                {formatDate(ticket.order.placedAt)} · {formatPrice(ticket.order.total)}
              </p>
              <ul className="mt-3 flex flex-col gap-1.5">
                {ticket.order.items.slice(0, 4).map((item, index) => (
                  <li key={`${item.name}-${index}`} className="truncate text-xs text-ink-700">
                    {item.quantity} × {item.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {ticket.details.length > 0 ? (
            <div className="rounded-card border border-ink-200 bg-shell p-4">
              <p className="label-wide text-ink-400">What you told us</p>
              <dl className="mt-2 flex flex-col gap-2.5">
                {ticket.details.map((detail) => (
                  <div key={detail.key}>
                    <dt className="text-[0.6875rem] text-ink-400">{detail.label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-sm text-ink-700">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </aside>
      </div>

      <Modal
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close this request?"
        description={`You can reopen it for ${config?.reopenDays ?? 7} days if you need to.`}
        className="max-w-md"
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmClose(false)} disabled={busy}>
            Keep it open
          </Button>
          <Button size="sm" onClick={() => void close()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Close request
          </Button>
        </div>
      </Modal>

      <ReopenDialog
        open={reopening}
        onOpenChange={setReopening}
        onReopen={async (why) => {
          try {
            setTicket(await reopenMyTicket(number, why, ticketKey));
            toast.success("Your request is open again.");
            setReopening(false);
          } catch (cause) {
            toast.error(reason(cause));
          }
        }}
      />
    </div>
  );
}

function ReopenDialog({
  open,
  onOpenChange,
  onReopen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReopen: (reason: string) => Promise<void>;
}) {
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Reopen this request" className="max-w-md">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          await onReopen(why);
          setSaving(false);
          setWhy("");
        }}
      >
        <Textarea
          label="What still needs sorting?"
          hint="Optional, but it helps whoever picks it up."
          rows={3}
          maxLength={500}
          value={why}
          onChange={(event) => setWhy(event.target.value)}
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Reopen request
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "How was your experience?" — offered once a request is resolved. */
function RateCard({
  ticket,
  ticketKey,
  onRated,
}: {
  ticket: CustomerTicket;
  ticketKey: string | null;
  onRated: (ticket: CustomerTicket) => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="rounded-card border border-copper-200 bg-copper-50 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (rating === 0) {
          setError("Choose from one to five stars.");
          return;
        }
        setSaving(true);
        try {
          onRated(await rateMyTicket(ticket.number, rating, comment, ticketKey));
          toast.success("Thank you for your feedback.");
        } catch (cause) {
          setError(reason(cause));
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="font-display text-base text-ink">How was your experience?</p>
      <p className="mt-0.5 text-xs text-ink-500">Your rating helps us get better.</p>
      <div className="mt-3">
        <StarInput
          value={rating}
          onChange={(value) => {
            setRating(value);
            setError(null);
          }}
        />
      </div>
      <div className={cn("grid transition-all", rating > 0 ? "mt-3 grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <Textarea
            label="Anything to add?"
            rows={2}
            maxLength={1000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" className="mt-3" disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        Send rating
      </Button>
    </form>
  );
}
