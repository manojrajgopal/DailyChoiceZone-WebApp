"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Download, Heart, RotateCcw, Sparkles, Trash2, X } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { EmptyState, ErrorState } from "@/components/common/States";
import { CompareSlider } from "@/components/tryon/CompareSlider";
import { useObjectUrl } from "@/components/tryon/useTryOn";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { Modal } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  ACTIVE_STATUSES,
  type TryOnAccessRequest,
  type TryOnAllocation,
  type TryOnEligibility,
  type TryOnPage,
  type TryOnPhoto,
  type TryOnRequest,
  cancelTryOn,
  deleteTryOn,
  deleteTryOnPhoto,
  getTryOn,
  getTryOnEligibility,
  listAccessRequests,
  listMyAllocations,
  listTryOnPhotos,
  listTryOns,
  requestTryOnAccess,
  retentionText,
  retryTryOn,
  setTryOnFavourite,
  statusText,
  tryOnDownloadLink,
  tryOnImage,
  withdrawAccessRequest,
} from "@/services/tryOnService";
import { toast } from "@/store/toastStore";

type Tab = "history" | "photos" | "access";
const PAGE_SIZE = 12;

const STATUS_TONE: Record<string, "stock" | "neutral" | "sale" | "new" | "soldout"> = {
  succeeded: "stock",
  queued: "neutral",
  processing: "neutral",
  retrying: "neutral",
  failed: "sale",
  cancelled: "soldout",
  expired: "soldout",
};

function problem(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * The customer's virtual try-ons: what their plan allows, every try-on with
 * its result, saved photos, and asking for more access. Only their own — the
 * server answers nothing else.
 */
export function AccountTryOnView() {
  const signedIn = useConfirmedCustomer();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = (["history", "photos", "access"].includes(params.get("tab") ?? "") ? params.get("tab") : "history") as Tab;
  const openId = params.get("request");

  const [usage, setUsage] = useState<TryOnEligibility | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);

  const loadUsage = useCallback(
    () => getTryOnEligibility().then((value) => { setUsage(value); setUsageFailed(false); }, () => setUsageFailed(true)),
    [],
  );
  useEffect(() => {
    if (signedIn) void loadUsage();
  }, [signedIn, loadUsage]);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const text = next.toString();
    router.replace(`${pathname}${text ? `?${text}` : ""}`, { scroll: false });
  };

  return (
    <AccountShell title="Virtual try-on" description="See clothes on you before you buy. Your photos and results are private to you.">
      {usageFailed ? (
        <ErrorState onRetry={() => void loadUsage()} />
      ) : !usage ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <UsageCard usage={usage} />
      )}

      <div className="mt-8 flex gap-1 border-b border-ink-100" role="tablist" aria-label="Try-on sections">
        {(
          [
            ["history", "My try-ons"],
            ["photos", "Saved photos"],
            ["access", "More access"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => go({ tab: value === "history" ? null : value, request: null })}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm transition-colors",
              tab === value ? "border-ink text-ink" : "border-transparent text-ink-500 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {!signedIn ? null : tab === "history" ? (
          <History
            usage={usage}
            openId={openId}
            onOpen={(id) => go({ request: id })}
            onClose={() => go({ request: null })}
            onChanged={() => void loadUsage()}
          />
        ) : tab === "photos" ? (
          <Photos />
        ) : (
          <Access usage={usage} onChanged={() => void loadUsage()} />
        )}
      </div>
    </AccountShell>
  );
}

function UsageCard({ usage }: { usage: TryOnEligibility }) {
  if (!usage.eligible) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-card bg-cream-deep p-5">
        <p className="font-display text-lg text-ink">Virtual try-on is a membership benefit</p>
        <p className="text-sm text-ink-600">
          {usage.reason === "programme_off"
            ? "Virtual try-on is switched off at the moment."
            : "Choose a membership that includes virtual try-on to see items on you before you buy."}
        </p>
        {usage.reason !== "programme_off" ? <ButtonLink href="/membership">See memberships</ButtonLink> : null}
      </div>
    );
  }
  const source =
    usage.source === "plan" ? usage.planName : usage.source === "trial" ? "Free trial" : "Extra access from us";
  return (
    <div className="grid gap-4 rounded-card bg-cream-deep p-5 sm:grid-cols-3">
      <div>
        <p className="label-wide text-ink-500">Your allowance</p>
        <p className="mt-1 font-display text-2xl text-ink">
          {usage.remaining === null ? "Unlimited" : `${usage.remaining} left`}
        </p>
        <p className="text-sm text-ink-600">
          {source}
          {usage.perPeriod && usage.source === "plan" ? ` · ${usage.usedThisPeriod} of ${usage.perPeriod} used` : ""}
        </p>
        {usage.resetsAt ? <p className="text-xs text-ink-500">Renews {formatDate(usage.resetsAt)}</p> : null}
      </div>
      <div>
        <p className="label-wide text-ink-500">Keeping your results</p>
        <p className="mt-1 text-sm text-ink-700">{retentionText(usage)}</p>
        {usage.storageQuota ? (
          <p className="mt-1 text-xs text-ink-500">{usage.storedResults} of {usage.storageQuota} saved.</p>
        ) : null}
      </div>
      <div>
        <p className="label-wide text-ink-500">Good to know</p>
        <ul className="mt-1 space-y-0.5 text-sm text-ink-700">
          <li>Only successful try-ons count.</li>
          {usage.perDay ? <li>Up to {usage.perDay} a day.</li> : null}
          {usage.allocations.length ? (
            <li>
              Extra: {usage.allocations.map((a) => (a.remaining === null ? "unlimited" : `${a.remaining} left`)).join(", ")}
              {usage.allocations.some((a) => a.dedicated) ? " (dedicated capacity)" : ""}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function History({
  usage,
  openId,
  onOpen,
  onClose,
  onChanged,
}: {
  usage: TryOnEligibility | null;
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState("");
  const [favourites, setFavourites] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TryOnPage | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    () =>
      listTryOns({ status, favourites, from: from || undefined, to: to || undefined, page, pageSize: PAGE_SIZE }).then(
        (value) => { setData(value); setFailed(false); },
        () => setFailed(true),
      ),
    [status, favourites, from, to, page],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Keep running try-ons fresh without reloading everything else.
  const running = data?.items.some((r) => ACTIVE_STATUSES.includes(r.status));
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void load(), 3000);
    return () => clearTimeout(timer);
  }, [running, data, load]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Show"
          value={status}
          onChange={(event) => { setStatus(event.target.value); setPage(1); }}
          options={[
            { value: "", label: "All" },
            { value: "active", label: "In progress" },
            { value: "succeeded", label: "Ready" },
            { value: "failed", label: "Couldn't be created" },
            { value: "expired", label: "Expired" },
          ]}
          className="w-44"
        />
        <Input label="From" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="w-40" />
        <Input label="To" type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="w-40" />
        <Button
          variant={favourites ? "primary" : "ghost"}
          className={cn(!favourites && "border border-ink-200")}
          aria-pressed={favourites}
          onClick={() => { setFavourites(!favourites); setPage(1); }}
        >
          <Heart className={cn("h-4 w-4", favourites && "fill-current")} aria-hidden="true" /> Favourites
        </Button>
      </div>

      <div className="mt-6">
        {failed ? (
          <ErrorState onRetry={() => void load()} />
        ) : !data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState
            title="No try-ons yet"
            description={usage?.eligible ? "Open a product that supports virtual try-on and press “Try it on”." : "Virtual try-on is included with selected memberships."}
            action={usage?.eligible ? { label: "Browse what you can try on", href: "/try-on" } : { label: "See memberships", href: "/membership" }}
          />
        ) : (
          <>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.items.map((request) => (
                <li key={request.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(request.id)}
                    className="flex w-full gap-3 rounded-card border border-ink-100 p-3 text-left transition-colors hover:border-ink-300"
                  >
                    {request.product.image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- the product's public photo, small
                      <img src={request.product.image} alt="" className="h-20 w-16 shrink-0 rounded-control object-cover" />
                    ) : (
                      <span className="h-20 w-16 shrink-0 rounded-control bg-cream-deep" />
                    )}
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-sm font-medium text-ink">{request.product.name}</span>
                      <span className="text-xs text-ink-500">{formatDate(request.createdAt)}</span>
                      <span className="flex items-center gap-1.5">
                        <Badge tone={STATUS_TONE[request.status] ?? "neutral"}>{statusText(request)}</Badge>
                        {request.favourite ? <Heart className="h-3.5 w-3.5 fill-clay-500 text-clay-500" aria-label="Favourite" /> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {data.pagination.total_pages > 1 ? (
              <Pagination className="mt-6" page={data.pagination.page} totalPages={data.pagination.total_pages} onPageChange={setPage} />
            ) : null}
          </>
        )}
      </div>

      {openId ? (
        <Detail
          id={openId}
          onClose={onClose}
          onChanged={() => {
            void load();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [request, setRequest] = useState<TryOnRequest | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    getTryOn(id).then((value) => active && setRequest(value), () => active && setMissing(true));
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!request || !ACTIVE_STATUSES.includes(request.status)) return;
    const timer = setTimeout(() => {
      getTryOn(id).then((next) => {
        setRequest(next);
        if (!ACTIVE_STATUSES.includes(next.status)) onChanged();
      }, () => undefined);
    }, 2000);
    return () => clearTimeout(timer);
  }, [id, request, onChanged]);

  const ready = request?.result.available ?? false;
  const result = useObjectUrl(ready ? () => tryOnImage(id, "result") : null, [id, ready]);
  const original = useObjectUrl(ready && request?.original.available ? () => tryOnImage(id, "original") : null, [id, ready]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (error) {
      toast.error(problem(error, "That didn't work. Please try again."));
    }
  };

  const download = async () => {
    try {
      const link = await tryOnDownloadLink(id);
      const anchor = document.createElement("a");
      anchor.href = link ?? result.url ?? "";
      anchor.download = `try-on-${id}.jpg`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      toast.error(problem(error, "The download didn't work."));
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={request ? request.product.name : "Try-on"} className="max-w-2xl">
      {missing ? (
        <p className="text-sm text-ink-600">This try-on isn&rsquo;t available.</p>
      ) : !request ? (
        <Skeleton className="aspect-[3/4] w-full" />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-600" role="status" aria-live="polite">
            {statusText(request)} · {formatDate(request.createdAt)}
            {request.color ? ` · ${request.color}` : ""}
            {request.size ? ` · size ${request.size}` : ""}
          </p>

          {ready ? (
            result.url ? (
              original.url ? (
                <CompareSlider before={original.url} after={result.url} className="aspect-[3/4] max-h-[60vh] w-full" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a private object URL
                <img src={result.url} alt={`You wearing ${request.product.name}`} className="max-h-[60vh] w-full rounded-card object-contain" />
              )
            ) : result.failed ? (
              <p className="text-sm text-danger">This image isn&rsquo;t available any more.</p>
            ) : (
              <Skeleton className="aspect-[3/4] w-full" />
            )
          ) : request.error ? (
            <p className="rounded-card bg-cream-deep p-4 text-sm text-ink-700" role="alert">{request.error.message}</p>
          ) : request.status === "expired" ? (
            <p className="text-sm text-ink-600">This result was kept for its retention period and has been deleted.</p>
          ) : null}

          {ready ? (
            <p className="text-xs text-ink-500">
              {request.result.mode === "ephemeral"
                ? "Not saved — download it if you'd like to keep it."
                : request.result.expiresAt
                  ? `Kept until ${formatDate(request.result.expiresAt)}.`
                  : "Kept until you delete it."}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {request.product.id ? <ButtonLink href={`/product/${request.product.id}`} variant="outline">View item</ButtonLink> : null}
            {ready && request.result.downloadable ? (
              <Button variant="outline" onClick={() => void download()} disabled={!result.url}>
                <Download className="h-4 w-4" aria-hidden="true" /> Download
              </Button>
            ) : null}
            {request.status === "succeeded" ? (
              <Button
                variant="ghost"
                className="border border-ink-200"
                aria-pressed={request.favourite}
                onClick={() =>
                  void act(async () => setRequest({ ...request, favourite: (await setTryOnFavourite(id, !request.favourite)).favourite }),
                    request.favourite ? "Removed from favourites" : "Added to favourites")
                }
              >
                <Heart className={cn("h-4 w-4", request.favourite && "fill-clay-500 text-clay-500")} aria-hidden="true" />
                {request.favourite ? "Favourite" : "Add to favourites"}
              </Button>
            ) : null}
            {request.canRetry ? (
              <Button onClick={() => void act(async () => setRequest(await retryTryOn(id)), "Trying again")}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" /> Try again
              </Button>
            ) : null}
            {request.canCancel ? (
              <Button variant="ghost" onClick={() => void act(async () => setRequest(await cancelTryOn(id)), "Cancelling")}>
                <X className="h-4 w-4" aria-hidden="true" /> Cancel
              </Button>
            ) : null}
            {!ACTIVE_STATUSES.includes(request.status) ? (
              <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
              </Button>
            ) : null}
          </div>

          <ConfirmModal
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title="Delete this try-on?"
            message="The result and your photo (unless you saved it) are deleted for good."
            confirmLabel="Delete"
            onConfirm={async () => {
              try {
                const outcome = await deleteTryOn(id);
                toast.success(outcome.pending ? "Deleted. It may take a few minutes to be removed from storage." : "Deleted.");
                onChanged();
                onClose();
              } catch (error) {
                toast.error(problem(error, "We couldn't delete it."));
              }
            }}
          />
        </div>
      )}
    </Modal>
  );
}

function Photos() {
  const [photos, setPhotos] = useState<TryOnPhoto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => listTryOnPhotos().then((v) => { setPhotos(v); setFailed(false); }, () => setFailed(true)), []);
  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;
  if (!photos) return <Skeleton className="h-24 w-full" />;
  if (!photos.length) {
    return (
      <EmptyState
        title="No saved photos"
        description="When you upload a photo for a try-on you can choose to save it for next time. Saved photos are private and you can delete them here."
      />
    );
  }
  return (
    <>
      <ul className="divide-y divide-ink-100 rounded-card border border-ink-100">
        {photos.map((photo, index) => (
          <li key={photo.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span>
              Photo {index + 1} · {photo.width}×{photo.height} · saved {formatDate(photo.createdAt)}
              {photo.expiresAt ? ` · kept until ${formatDate(photo.expiresAt)}` : ""}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(photo.id)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmModal
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this photo?"
        message="It is removed from our storage. Try-ons already made with it keep their results."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteTryOnPhoto(deleting);
            toast.success("Photo deleted.");
            void load();
          } catch (error) {
            toast.error(problem(error, "We couldn't delete it."));
          }
        }}
      />
    </>
  );
}

const ACCESS_STATUS: Record<string, string> = {
  pending: "Waiting for a reply",
  approved: "Approved",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  disabled: "Paused",
};

function Access({ usage, onChanged }: { usage: TryOnEligibility | null; onChanged: () => void }) {
  const [requests, setRequests] = useState<TryOnAccessRequest[] | null>(null);
  const [allocations, setAllocations] = useState<TryOnAllocation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<"more_usage" | "dedicated">("more_usage");
  const [reason, setReason] = useState("");
  const [expected, setExpected] = useState("10");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([listAccessRequests(), listMyAllocations()]).then(
        ([r, a]) => { setRequests(r); setAllocations(a); setFailed(false); },
        () => setFailed(true),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    try {
      await requestTryOnAccess({
        kind,
        reason,
        expectedUsage: Number(expected) || 0,
        startsOn: startsOn || null,
        endsOn: endsOn || null,
        message,
      });
      toast.success("Request sent. We'll let you know.");
      setReason("");
      setMessage("");
      void load();
      onChanged();
    } catch (error) {
      toast.error(problem(error, "We couldn't send your request."));
    } finally {
      setSending(false);
    }
  };

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section>
        <h2 className="font-display text-lg text-ink">Ask for more try-ons</h2>
        {usage && !usage.allocationRequests ? (
          <p className="mt-2 text-sm text-ink-600">Your plan doesn&rsquo;t include requesting extra access.</p>
        ) : (
          <form className="mt-4 flex flex-col gap-4" onSubmit={send}>
            <Select
              label="What do you need?"
              value={kind}
              onChange={(event) => setKind(event.target.value as "more_usage" | "dedicated")}
              options={[
                { value: "more_usage", label: "More try-ons" },
                { value: "dedicated", label: "Dedicated capacity (for frequent use)" },
              ]}
            />
            <Textarea label="Why do you need it?" required minLength={5} maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
            <Input label="How many try-ons do you expect to need?" type="number" min={0} max={100000} value={expected} onChange={(event) => setExpected(event.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="From (optional)" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
              <Input label="Until (optional)" type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
            </div>
            <Textarea label="Message (optional)" rows={2} maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} />
            <Button type="submit" disabled={sending || reason.trim().length < 5} className="self-start">
              <Sparkles className="h-4 w-4" aria-hidden="true" /> Send request
            </Button>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-6">
        <div>
          <h2 className="font-display text-lg text-ink">Extra access</h2>
          {!allocations ? (
            <Skeleton className="mt-3 h-16 w-full" />
          ) : allocations.length === 0 ? (
            <p className="mt-2 text-sm text-ink-600">None yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100 rounded-card border border-ink-100">
              {allocations.map((a) => (
                <li key={a.id} className="px-4 py-3 text-sm">
                  <p className="text-ink">
                    {a.generations === null ? "Unlimited try-ons" : `${a.remaining} of ${a.generations} try-ons left`}
                    {a.dedicated ? " · dedicated capacity" : ""}
                  </p>
                  <p className="text-xs text-ink-500">
                    {ACCESS_STATUS[a.status] ?? a.status}
                    {a.endsAt ? ` · until ${formatDate(a.endsAt)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="font-display text-lg text-ink">Your requests</h2>
          {!requests ? (
            <Skeleton className="mt-3 h-16 w-full" />
          ) : requests.length === 0 ? (
            <p className="mt-2 text-sm text-ink-600">You haven&rsquo;t asked for anything yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100 rounded-card border border-ink-100">
              {requests.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                  <span>
                    <span className="block text-ink">{r.kind === "dedicated" ? "Dedicated capacity" : "More try-ons"} · {formatDate(r.createdAt)}</span>
                    <span className="block text-xs text-ink-500">{ACCESS_STATUS[r.status] ?? r.status}{r.decisionNote ? ` — ${r.decisionNote}` : ""}</span>
                  </span>
                  {r.status === "pending" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void withdrawAccessRequest(r.id).then(
                          () => { toast.success("Request withdrawn."); void load(); },
                          (error) => toast.error(problem(error, "We couldn't withdraw it.")),
                        )
                      }
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-ink-500">
          Questions? <Link href="/account/support" className="underline underline-offset-2">Contact support</Link>.
        </p>
      </section>
    </div>
  );
}
