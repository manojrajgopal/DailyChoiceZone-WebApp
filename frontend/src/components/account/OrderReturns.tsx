"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCcw, Undo2 } from "lucide-react";

import type { Order } from "@/types";
import type {
  ReturnEligibility,
  ReturnKind,
  ReturnRequest,
} from "@/types/returns";

import { ProductImage } from "@/components/common/ProductImage";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { RETURN_STAGES, RETURN_STATUS_LABELS } from "@/types/returns";
import { cancelReturn, getOrderReturns, requestReturn } from "@/services/returnsService";
import { toast } from "@/store/toastStore";

const KIND_COPY: Record<ReturnKind, { title: string; body: string; icon: typeof Undo2 }> = {
  return: {
    title: "Return for a refund",
    body: "Send it back and we'll refund you to your original payment method once it reaches us.",
    icon: Undo2,
  },
  replacement: {
    title: "Replace with the same item",
    body: "For something damaged, faulty or wrong — we'll send you a new one.",
    icon: RefreshCcw,
  },
};

/**
 * Returns and replacements on the order page.
 *
 * Shown once the order is delivered: the requests made so far, each with its
 * progress, and — while the window is open — a way to start a new one. Which
 * items qualify, and until when, comes from the server; this only presents it.
 */
export function OrderReturns({ order }: { order: Order }) {
  const [eligibility, setEligibility] = useState<ReturnEligibility | null>(null);
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [formOpen, setFormOpen] = useState(false);

  const delivered = order.status === "delivered" || order.status === "returned";

  const load = useCallback(async () => {
    try {
      const result = await getOrderReturns(order.id);
      setEligibility(result.eligibility);
      setRequests(result.requests);
    } catch {
      setEligibility(null);
    }
  }, [order.id]);

  useEffect(() => {
    if (delivered) void load();
  }, [delivered, load]);

  if (!delivered || !eligibility) return null;

  return (
    <section
      aria-labelledby="returns-heading"
      className="rounded-card border border-ink-200 bg-shell p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="returns-heading" className="label-wide text-ink">
            Returns &amp; replacements
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            {eligibility.eligible && eligibility.windowEndsAt
              ? `You can return or replace eligible items until ${formatDate(eligibility.windowEndsAt)}.`
              : eligibility.reason}
          </p>
        </div>
        {eligibility.eligible && !formOpen ? (
          <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
            Return or replace items
          </Button>
        ) : null}
      </div>

      {formOpen ? (
        <ReturnForm
          orderId={order.id}
          eligibility={eligibility}
          onCancel={() => setFormOpen(false)}
          onDone={async () => {
            setFormOpen(false);
            await load();
          }}
        />
      ) : null}

      {requests.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-4">
          {requests.map((request) => (
            <RequestCard key={request.id} request={request} onChanged={load} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------------- the form */

function ReturnForm({
  orderId,
  eligibility,
  onCancel,
  onDone,
}: {
  orderId: string;
  eligibility: ReturnEligibility;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const canReturn = eligibility.items.some((item) => item.returnable);
  const canReplace = eligibility.items.some((item) => item.replaceable);

  const [kind, setKind] = useState<ReturnKind>(canReturn ? "return" : "replacement");
  const [chosen, setChosen] = useState<Record<number, number>>({});
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  const flag = kind === "return" ? "returnable" : "replaceable";
  const selected = Object.entries(chosen).filter(([, quantity]) => quantity > 0);

  const chooseKind = (next: ReturnKind) => {
    setKind(next);
    setChosen({});
    setReason("");
  };

  const submit = async () => {
    if (!selected.length) {
      toast.error("Choose at least one item.");
      return;
    }
    if (!reason) {
      toast.error("Please tell us why.");
      return;
    }
    setSending(true);
    const result = await requestReturn(orderId, {
      kind,
      reason,
      comment,
      items: selected.map(([id, quantity]) => ({ orderItemId: Number(id), quantity })),
    });
    setSending(false);
    if (!result.ok) {
      toast.error(result.reason);
      return;
    }
    toast.success(
      kind === "return"
        ? "Return requested. We'll be in touch to arrange the pickup."
        : "Replacement requested. We'll be in touch to arrange the pickup.",
    );
    await onDone();
  };

  return (
    <div className="mt-5 rounded-card border border-ink-200 bg-cream p-4 sm:p-5">
      {/* Step 1 — what they want */}
      <fieldset>
        <legend className="text-sm font-medium text-ink">What would you like to do?</legend>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          {(["return", "replacement"] as const).map((option) => {
            const available = option === "return" ? canReturn : canReplace;
            const { title, body, icon: Icon } = KIND_COPY[option];
            return (
              <label
                key={option}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-card border p-3.5 transition-colors",
                  kind === option ? "border-ink bg-shell" : "border-ink-200 bg-shell/60",
                  !available && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="radio"
                  name="return-kind"
                  value={option}
                  checked={kind === option}
                  disabled={!available}
                  onChange={() => chooseKind(option)}
                  className="sr-only"
                />
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.75} aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium text-ink">{title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                    {available
                      ? body
                      : option === "return"
                        ? "None of these items can be returned."
                        : "None of these items can be replaced."}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Step 2 — which items */}
      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-ink">Which items?</legend>
        <ul className="mt-3 flex flex-col divide-y divide-ink-100 rounded-card border border-ink-200 bg-shell">
          {eligibility.items.map((item) => {
            const eligible = item[flag];
            const quantity = chosen[item.orderItemId] ?? 0;
            const why = !item.available
              ? "Already requested"
              : kind === "return"
                ? "Not returnable"
                : "Not replaceable";
            return (
              <li
                key={item.orderItemId}
                className={cn("flex items-center gap-3 p-3", !eligible && "opacity-55")}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${item.name}`}
                  disabled={!eligible}
                  checked={quantity > 0}
                  onChange={(event) =>
                    setChosen((current) => ({
                      ...current,
                      [item.orderItemId]: event.target.checked ? Math.min(1, item.available) : 0,
                    }))
                  }
                  className="h-4 w-4 shrink-0 accent-ink"
                />
                <ProductImage
                  src={item.image}
                  alt=""
                  sizes="48px"
                  wrapperClassName="h-14 w-11 shrink-0 rounded-[3px]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{item.name}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {[item.size, item.color].filter(Boolean).join(" · ") || `Qty ${item.quantity}`}
                    {!eligible ? <span className="ml-2 text-clay-600">{why}</span> : null}
                  </p>
                </div>
                {eligible && item.available > 1 && quantity > 0 ? (
                  <label className="shrink-0 text-xs text-ink-500">
                    <span className="sr-only">Quantity of {item.name}</span>
                    <select
                      value={quantity}
                      onChange={(event) =>
                        setChosen((current) => ({
                          ...current,
                          [item.orderItemId]: Number(event.target.value),
                        }))
                      }
                      className="h-9 rounded-control border border-ink-200 bg-shell px-2 text-sm text-ink"
                    >
                      {Array.from({ length: item.available }, (_, index) => index + 1).map((value) => (
                        <option key={value} value={value}>
                          {value} of {item.available}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* Step 3 — why */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Reason</span>
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="h-11 rounded-control border border-ink-200 bg-shell px-3 text-sm text-ink focus:border-copper-500 focus:outline-none"
          >
            <option value="">Choose a reason</option>
            {(eligibility.reasons[kind] ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium text-ink">
            Anything else we should know? <span className="font-normal text-ink-400">(optional)</span>
          </span>
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value.slice(0, 1000))}
            rows={3}
            placeholder="For example, what is wrong with the item."
            className="rounded-control border border-ink-200 bg-shell px-3 py-2.5 text-sm text-ink placeholder:text-ink-300 focus:border-copper-500 focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={() => void submit()} disabled={sending}>
          {sending ? "Sending…" : kind === "return" ? "Request return" : "Request replacement"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
        <p className="w-full text-xs leading-relaxed text-ink-500 sm:w-auto sm:flex-1">
          We&rsquo;ll collect the item from your delivery address. Please keep it unused, with
          its tags and original packaging.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- one request */

function RequestCard({ request, onChanged }: { request: ReturnRequest; onChanged: () => Promise<void> }) {
  const [cancelling, setCancelling] = useState(false);
  const stages = RETURN_STAGES[request.kind];
  const closed = request.status === "rejected" || request.status === "cancelled";
  const at = stages.indexOf(request.status);

  const cancel = async () => {
    setCancelling(true);
    try {
      await cancelReturn(request.id);
      toast.success("Your request has been cancelled.");
      await onChanged();
    } catch {
      toast.error("We couldn't cancel this request. Please try again.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <li className="rounded-card border border-ink-200 bg-cream p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-ink">
          {request.kind === "return" ? "Return" : "Replacement"}
          <span className="ml-2 text-xs font-normal text-ink-400">
            {request.id} · {formatDate(request.createdAt)}
          </span>
        </p>
        <span
          className={cn(
            "rounded-pill px-2.5 py-0.5 text-xs font-medium",
            closed ? "bg-ink-100 text-ink-600" : request.status === "refunded" || request.status === "completed"
              ? "bg-sage-100 text-sage-700"
              : "bg-copper-50 text-copper-700",
          )}
        >
          {RETURN_STATUS_LABELS[request.status]}
        </span>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {request.items.map((item) => (
          <li key={item.orderItemId} className="flex items-center gap-3 text-sm text-ink-700">
            <ProductImage src={item.image} alt="" sizes="40px" wrapperClassName="h-12 w-9 shrink-0 rounded-[3px]" />
            <span className="min-w-0 flex-1 truncate">
              {item.name}
              {item.quantity > 1 ? ` × ${item.quantity}` : ""}
            </span>
          </li>
        ))}
      </ul>

      {!closed ? (
        <ol className="mt-4 flex flex-wrap gap-x-1 gap-y-2" aria-label="Progress">
          {stages.map((stage, index) => {
            const reached = index <= at;
            return (
              <li key={stage} className="flex items-center gap-1 text-[0.6875rem]">
                <span
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded-pill",
                    reached ? "bg-sage-500 text-white" : "bg-ink-100 text-ink-400",
                  )}
                  aria-hidden="true"
                >
                  {reached ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
                </span>
                <span className={reached ? "text-ink" : "text-ink-400"}>
                  {RETURN_STATUS_LABELS[stage]}
                </span>
                {index < stages.length - 1 ? (
                  <span aria-hidden="true" className="mx-1 text-ink-300">
                    ›
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      <p className="mt-3 text-xs leading-relaxed text-ink-500">
        Reason: {request.reason}
        {request.kind === "return" && request.amount > 0
          ? ` · Refund ${formatMoney(request.amount)}`
          : ""}
      </p>
      {request.resolutionNote ? (
        <p className="mt-1.5 text-xs leading-relaxed text-ink-700">
          <span className="font-medium">From us:</span> {request.resolutionNote}
        </p>
      ) : null}

      {request.canCancel ? (
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={cancelling}
          className="mt-3 text-xs font-medium text-clay-700 underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          {cancelling ? "Cancelling…" : "Cancel request"}
        </button>
      ) : null}
    </li>
  );
}
