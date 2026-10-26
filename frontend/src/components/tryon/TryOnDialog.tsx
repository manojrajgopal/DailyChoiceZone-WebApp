"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, Download, ImagePlus, Loader2, RotateCcw, ShieldCheck, Sparkles, Star, X } from "lucide-react";

import type { Product } from "@/types";

import { CompareSlider } from "@/components/tryon/CompareSlider";
import { useObjectUrl } from "@/components/tryon/useTryOn";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Checkbox, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  ACTIVE_STATUSES,
  type TryOnOffer,
  type TryOnPhoto,
  type TryOnRequest,
  cancelTryOn,
  getTryOn,
  getTryOnOffer,
  listTryOnPhotos,
  newRequestKey,
  rateTryOn,
  retentionText,
  retryTryOn,
  startTryOn,
  statusText,
  tryOnDownloadLink,
  tryOnImage,
  uploadTryOnPhoto,
} from "@/services/tryOnService";
import { toast } from "@/store/toastStore";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const POLL_MS = 2000;

type Step = "loading" | "blocked" | "photo" | "running" | "done" | "failed";

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** Reads a chosen file's size in pixels, so an unusable photo is caught before it is sent. */
async function dimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Virtual try-on for one product: requirements and privacy, a photo, the
 * confirmation, progress while it runs, and the result beside the original.
 *
 * Mounted for each opening (the button renders it only while open), so every
 * opening starts from a clean slate and a fresh request key.
 *
 * Every rule (plan, limits, the product's eligibility) is the server's: this
 * shows what the server says and never decides on its own. Credentials and
 * model internals never reach the browser — at most a quality choice.
 */
export function TryOnDialog({
  open,
  onOpenChange,
  product,
  color,
  size,
  onAddToBag,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Pick<Product, "id" | "name" | "colors" | "sizes">;
  color: string | null;
  size: string | null;
  onAddToBag?: () => void;
}) {
  const [step, setStep] = useState<Step>("loading");
  const [offer, setOffer] = useState<TryOnOffer | null>(null);
  const [blockedReason, setBlockedReason] = useState("");
  const [photos, setPhotos] = useState<TryOnPhoto[]>([]);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [savePhoto, setSavePhoto] = useState(false);
  const [modelId, setModelId] = useState("");
  const [starting, setStarting] = useState(false);
  const [request, setRequest] = useState<TryOnRequest | null>(null);
  const [rating, setRating] = useState(0);
  const keyRef = useRef<string>(newRequestKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  // Open: ask the server what's possible for this product and this customer.
  useEffect(() => {
    if (!open) return;
    let active = true;
    getTryOnOffer(product.id).then(
      (value) => {
        if (!active) return;
        setOffer(value);
        setModelId(value.models[0]?.id ?? "");
        const e = value.eligibility;
        if (value.state !== "available") {
          setBlockedReason(value.state);
        } else if (!e) {
          setBlockedReason("signed_out");
        } else if (!e.eligible) {
          setBlockedReason(e.reason || "plan_ineligible");
        } else if (e.remaining === 0 && !e.allocations.some((a) => a.remaining === null || a.remaining > 0)) {
          setBlockedReason("limit_reached");
        } else {
          setStep("photo");
          listTryOnPhotos().then((saved) => active && setPhotos(saved), () => undefined);
          return;
        }
        setStep("blocked");
      },
      (error) => {
        if (!active) return;
        setBlockedReason("error");
        setOffer(null);
        setStep("blocked");
        toast.error(message(error, "Virtual try-on isn't available right now."));
      },
    );
    return () => {
      active = false;
    };
  }, [open, product.id]);

  // Revoke the local preview when it's replaced or the dialog goes away.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // Follow a running request until it ends.
  useEffect(() => {
    if (!open || !request || !ACTIVE_STATUSES.includes(request.status)) return;
    const timer = setTimeout(() => {
      getTryOn(request.id).then(
        (next) => {
          setRequest(next);
          if (next.status === "succeeded") setStep("done");
          else if (!ACTIVE_STATUSES.includes(next.status)) setStep("failed");
        },
        () => undefined, // a missed poll: the next one tries again
      );
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [open, request]);

  const eligibility = offer?.eligibility ?? null;
  const rules = offer?.capability?.inputRules ?? {};
  const maxBytes = Math.round((eligibility?.maxUploadMb ?? 8) * 1024 * 1024);
  const canSave = offer?.storage.mode === "s3";

  const choose = async (file: File | undefined) => {
      setUploadError("");
      if (!file) return;
      if (!ACCEPTED.includes(file.type)) {
        setUploadError("Please choose a JPEG, PNG or WebP photo.");
        return;
      }
      if (file.size > maxBytes) {
        setUploadError(`Photos must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`);
        return;
      }
      const size = await dimensions(file);
      if (size && (size.width < (rules.minWidth ?? 0) || size.height < (rules.minHeight ?? 0))) {
        setUploadError(`Please use a larger photo — at least ${rules.minWidth}×${rules.minHeight} pixels.`);
        return;
      }
      setPreview(URL.createObjectURL(file));
      setUploading(true);
      try {
        const photo = await uploadTryOnPhoto(file, { save: canSave && savePhoto, capability: offer?.capability?.key });
        setPhotoId(photo.id);
      } catch (error) {
        setPhotoId(null);
        setUploadError(message(error, "We couldn't upload that photo. Please try again."));
      } finally {
        setUploading(false);
      }
  };

  const begin = async () => {
    if (!photoId) return;
    setStarting(true);
    try {
      const started = await startTryOn(
        { productId: product.id, photoId, color, size, modelId: offer?.models.length ? modelId || null : null },
        keyRef.current,
      );
      setRequest(started);
      setStep(started.status === "succeeded" ? "done" : ACTIVE_STATUSES.includes(started.status) ? "running" : "failed");
    } catch (error) {
      toast.error(message(error, "We couldn't start your try-on. Please try again."));
      // A refused request used no key: the next press gets a new one.
      keyRef.current = newRequestKey();
    } finally {
      setStarting(false);
    }
  };

  const retry = async () => {
    if (!request) return;
    try {
      const next = await retryTryOn(request.id);
      setRequest(next);
      setStep("running");
    } catch (error) {
      toast.error(message(error, "We couldn't retry just now."));
    }
  };

  const cancel = async () => {
    if (!request) return;
    try {
      setRequest(await cancelTryOn(request.id));
      toast.info("Cancelling your try-on.");
    } catch (error) {
      toast.error(message(error, "We couldn't cancel it."));
    }
  };

  const startOver = () => {
    keyRef.current = newRequestKey();
    setRequest(null);
    setPhotoId(null);
    setPreview(null);
    setRating(0);
    setStep("photo");
  };

  const title = offer?.capability ? `Try on · ${product.name}` : "Virtual try-on";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description="See how it looks on you before you buy." className="max-w-2xl">
      {step === "loading" ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : step === "blocked" ? (
        <Blocked reason={blockedReason} offer={offer} />
      ) : step === "photo" ? (
        <div className="flex flex-col gap-5">
          {offer?.capability?.guidance.length ? (
            <div className="rounded-card bg-cream-deep p-4">
              <p className="text-sm font-medium text-ink">For the best result</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-600">
                {offer.capability.guidance.map((tip) => <li key={tip}>{tip}</li>)}
              </ul>
            </div>
          ) : null}

          {photos.length ? (
            <div>
              <p className="label-wide text-ink-500">Your saved photos</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {photos.map((photo, index) => (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => {
                      setPhotoId(photo.id);
                      setPreview(null);
                      setUploadError("");
                    }}
                    aria-pressed={photoId === photo.id}
                    className={cn(
                      "rounded-control border px-3 py-2 text-sm transition-colors",
                      photoId === photo.id ? "border-ink bg-ink text-cream" : "border-ink-200 hover:border-ink",
                    )}
                  >
                    Photo {index + 1} · {formatDate(photo.createdAt)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-[6.5rem_1fr] gap-4 sm:grid-cols-[10rem_1fr]">
            <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-card border border-dashed border-ink-300 bg-shell">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file
                <img src={preview} alt="Your chosen photo" className="h-full w-full object-cover" />
              ) : (
                <ImagePlus className="h-8 w-8 text-ink-300" strokeWidth={1.25} aria-hidden="true" />
              )}
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="w-full px-3 sm:w-auto sm:px-6" onClick={() => fileInput.current?.click()} disabled={uploading}>
                  <ImagePlus className="h-4 w-4" aria-hidden="true" /> Choose a photo
                </Button>
                <Button variant="ghost" className="w-full border border-ink-200 px-3 sm:hidden" onClick={() => cameraInput.current?.click()} disabled={uploading}>
                  <Camera className="h-4 w-4" aria-hidden="true" /> Take one
                </Button>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPTED.join(",")}
                className="sr-only"
                aria-label="Choose a photo of yourself"
                onChange={(event) => {
                  void choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <input
                ref={cameraInput}
                type="file"
                accept="image/*"
                capture="user"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  void choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <p className="text-xs text-ink-500">
                JPEG, PNG or WebP, up to {eligibility?.maxUploadMb ?? 8} MB
                {rules.minWidth ? `, at least ${rules.minWidth}×${rules.minHeight} pixels` : ""}.
              </p>
              {canSave ? (
                <Checkbox
                  label="Save this photo for my next try-on"
                  checked={savePhoto}
                  onChange={(event) => setSavePhoto(event.target.checked)}
                />
              ) : null}
              {uploading ? (
                <p className="flex items-center gap-2 text-sm text-ink-600" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking your photo…
                </p>
              ) : uploadError ? (
                <p className="text-sm text-danger" role="alert">{uploadError}</p>
              ) : photoId && preview ? (
                <p className="flex items-center gap-2 text-sm text-sage-600" role="status">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Photo ready
                </p>
              ) : null}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 rounded-card border border-ink-100 p-4 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-500">Item</dt><dd className="text-ink">{product.name}</dd></div>
            <div><dt className="text-ink-500">Type</dt><dd className="text-ink">{offer?.capability?.name}</dd></div>
            {color ? <div><dt className="text-ink-500">Colour</dt><dd className="text-ink">{color}</dd></div> : null}
            {size ? <div><dt className="text-ink-500">Size</dt><dd className="text-ink">{size}</dd></div> : null}
          </dl>

          {offer && offer.models.length > 1 ? (
            <Select
              label="Quality"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              options={offer.models.map((m) => ({ value: m.id, label: `${m.name} · about ${m.avgSeconds}s` }))}
            />
          ) : null}

          <Allowance offer={offer} />

          <p className="flex gap-2 text-xs leading-relaxed text-ink-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sage-600" aria-hidden="true" />
            <span>{offer?.privacyNotice} {eligibility ? retentionText(eligibility) : ""}</span>
          </p>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Not now</Button>
            <Button onClick={() => void begin()} disabled={!photoId || uploading || starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              Try it on
            </Button>
          </div>
        </div>
      ) : step === "running" && request ? (
        <Running request={request} onCancel={() => void cancel()} />
      ) : step === "done" && request ? (
        <Result
          request={request}
          showFeedback={offer?.feedback !== false}
          rating={rating}
          onRate={async (value) => {
            setRating(value);
            try {
              await rateTryOn(request.id, value);
              toast.success("Thanks for the feedback.");
            } catch {
              /* feedback is optional */
            }
          }}
          onAgain={startOver}
          onAddToBag={onAddToBag}
        />
      ) : request ? (
        <div className="flex flex-col items-start gap-4" role="alert">
          <p className="font-display text-lg text-ink">{request.status === "cancelled" ? "Try-on cancelled" : "We couldn't create your try-on"}</p>
          <p className="text-sm text-ink-600">{request.error?.message ?? "Please try again."}</p>
          <div className="flex flex-wrap gap-2">
            {request.canRetry ? (
              <Button onClick={() => void retry()}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" /> Try again
              </Button>
            ) : null}
            <Button variant="outline" onClick={startOver}>Use another photo</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Allowance({ offer }: { offer: TryOnOffer | null }) {
  const e = offer?.eligibility;
  if (!e) return null;
  if (e.source === "trial" && e.trial) {
    return <p className="text-sm text-ink-600">Free trial: {Math.max(e.trial.limit - e.trial.used, 0)} of {e.trial.limit} try-ons left.</p>;
  }
  if (e.remaining === null) return <p className="text-sm text-ink-600">Unlimited try-ons with {e.planName || "your plan"}.</p>;
  return (
    <p className="text-sm text-ink-600">
      {e.remaining} of {e.perPeriod} try-ons left
      {e.resetsAt ? ` · renews ${formatDate(e.resetsAt)}` : ""}. Only successful try-ons count.
    </p>
  );
}

function Blocked({ reason, offer }: { reason: string; offer: TryOnOffer | null }) {
  const name = offer?.capability?.name ?? "this item";
  const copy: Record<string, { title: string; body: string; action?: { label: string; href: string } }> = {
    coming_soon: { title: "Coming soon", body: `Virtual try-on for ${name.toLowerCase()} is on its way.` },
    unavailable: { title: "Not available right now", body: "Try-on for this item is temporarily unavailable. Please check back soon." },
    unsupported: { title: "Not available for this item", body: "Virtual try-on isn't offered for this item." },
    off: { title: "Not available right now", body: "Virtual try-on is switched off at the moment." },
    signed_out: {
      title: "Sign in to try it on",
      body: "Virtual try-on is part of your account.",
      // Back to this product afterwards.
      action: { label: "Sign in", href: `/account?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}` },
    },
    plan_ineligible: {
      title: "A membership benefit",
      body: "Virtual try-on is included with selected memberships. Upgrade to see this on you before you buy.",
      action: { label: "See memberships", href: "/membership" },
    },
    programme_off: { title: "Not available right now", body: "Virtual try-on is switched off at the moment." },
    limit_reached: {
      title: "You've used your try-ons",
      body: offer?.eligibility?.resetsAt
        ? `Your allowance renews on ${formatDate(offer.eligibility.resetsAt)}. You can also ask us for more.`
        : "You can ask us for more try-ons.",
      action: { label: "Ask for more", href: "/account/try-on?tab=access" },
    },
    error: { title: "Not available right now", body: "Please try again in a moment." },
  };
  const content = copy[reason] ?? copy.unsupported!;
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      <p className="font-display text-lg text-ink">{content.title}</p>
      <p className="text-sm text-ink-600">{content.body}</p>
      {content.action ? <ButtonLink href={content.action.href}>{content.action.label}</ButtonLink> : null}
    </div>
  );
}

function Running({ request, onCancel }: { request: TryOnRequest; onCancel: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <Loader2 className="h-10 w-10 animate-spin text-copper-500" aria-hidden="true" />
      <p className="font-display text-lg text-ink" role="status" aria-live="polite">
        {statusText(request)}
      </p>
      {request.etaSeconds ? (
        <p className="text-sm text-ink-500">About {Math.max(5, Math.round(request.etaSeconds / 5) * 5)} seconds left. You can close this — we&rsquo;ll let you know when it&rsquo;s ready.</p>
      ) : null}
      {request.canCancel ? (
        <Button variant="ghost" onClick={onCancel}>
          <X className="h-4 w-4" aria-hidden="true" /> Cancel
        </Button>
      ) : null}
    </div>
  );
}

function Result({
  request,
  showFeedback,
  rating,
  onRate,
  onAgain,
  onAddToBag,
}: {
  request: TryOnRequest;
  showFeedback: boolean;
  rating: number;
  onRate: (value: number) => void;
  onAgain: () => void;
  onAddToBag?: () => void;
}) {
  const result = useObjectUrl(() => tryOnImage(request.id, "result"), [request.id]);
  const original = useObjectUrl(request.original.available ? () => tryOnImage(request.id, "original") : null, [request.id]);
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const link = await tryOnDownloadLink(request.id);
      const anchor = document.createElement("a");
      anchor.href = link ?? result.url ?? "";
      anchor.download = `try-on-${request.id}.jpg`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      toast.error(message(error, "The download didn't work. Please try again."));
    } finally {
      setDownloading(false);
    }
  };

  const expiry = useMemo(() => {
    if (request.result.mode === "ephemeral") return "Not saved — download it if you'd like to keep it.";
    if (request.result.expiresAt) return `Kept until ${formatDate(request.result.expiresAt)}.`;
    return "Saved to your try-ons.";
  }, [request.result.expiresAt, request.result.mode]);

  return (
    <div className="flex flex-col gap-4">
      {result.failed ? (
        <p className="text-sm text-danger" role="alert">This image isn&rsquo;t available any more.</p>
      ) : !result.url ? (
        <Skeleton className="aspect-[3/4] w-full" />
      ) : original.url ? (
        <CompareSlider before={original.url} after={result.url} className="aspect-[3/4] max-h-[60vh] w-full" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a private object URL
        <img src={result.url} alt={`You wearing ${request.product.name}`} className="max-h-[60vh] w-full rounded-card object-contain" />
      )}
      <p className="text-xs text-ink-500">{expiry} AI images are an approximation of fit and colour.</p>

      {showFeedback ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-600" id={`rate-${request.id}`}>How does it look?</span>
          <div role="radiogroup" aria-labelledby={`rate-${request.id}`} className="flex">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                aria-label={`${value} star${value > 1 ? "s" : ""}`}
                onClick={() => onRate(value)}
                className="p-1"
              >
                <Star className={cn("h-5 w-5", value <= rating ? "fill-copper-500 text-copper-500" : "text-ink-300")} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {onAddToBag ? <Button onClick={onAddToBag}>Add to bag</Button> : null}
        {request.result.downloadable ? (
          <Button variant="outline" onClick={() => void download()} disabled={downloading || !result.url}>
            <Download className="h-4 w-4" aria-hidden="true" /> Download
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onAgain}>Try another photo</Button>
        <Link href="/account/try-on" className="self-center text-sm text-ink-600 underline underline-offset-2 hover:text-copper-700">
          All my try-ons
        </Link>
      </div>
    </div>
  );
}
