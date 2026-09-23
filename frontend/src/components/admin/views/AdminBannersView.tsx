"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";

import type { AdminBanner } from "@/types/admin";

import {
  AdminButton,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { AdminInput, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import {
  deleteBanner,
  emptyBanner,
  isLive,
  listBanners,
  moveBanner,
  saveBanner,
  toggleBanner,
} from "@/services/admin/bannerAdminService";
import { toast } from "@/store/toastStore";

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const fromDateInput = (value: string) =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;

/**
 * Promotional banners.
 *
 * These are the messages that rotate in the strip above the storefront header.
 * The status column distinguishes *enabled* from *live*: a banner can be
 * switched on but scheduled for next month, and conflating the two would have
 * an administrator hunting for a message that is working exactly as configured.
 */
export function AdminBannersView() {
  const banners = useAdminResource(() => listBanners(), []);

  const [editing, setEditing] = useState<AdminBanner | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminBanner | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = banners.data ?? [];
  const liveCount = rows.filter((banner) => isLive(banner)).length;

  const onSave = async () => {
    if (!editing) return;
    setBusy(true);
    const result = await saveBanner(editing);
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Banner saved");
    setEditing(null);
    await banners.reload();
  };

  const onToggle = async (banner: AdminBanner) => {
    setBusy(true);
    const result = await toggleBanner(banner.id);
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(banner.active ? "Banner switched off" : "Banner switched on");
    await banners.reload();
  };

  const onMove = async (id: string, direction: "up" | "down") => {
    setBusy(true);
    await moveBanner(id, direction);
    setBusy(false);
    await banners.reload();
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const result = await deleteBanner(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Banner deleted");
    await banners.reload();
  };

  return (
    <div>
      <AdminPageHeader
        title="Banners"
        description="The promotional messages that rotate above the storefront header."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Banners" }]}
        actions={
          <AdminButton variant="primary" onClick={() => setEditing(emptyBanner(rows.length + 1))}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add banner
          </AdminButton>
        }
      />

      <AdminCard
        title={`${rows.length} banners · ${liveCount} showing now`}
        description="Live means enabled and within its date window."
        padded={false}
      >
        {banners.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-[3px] bg-admin-raised" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-admin-muted">
            No banners yet. Add one to promote an offer.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-admin-border">
            {rows.map((banner, index) => {
              const live = isLive(banner);
              return (
                <li
                  key={banner.id}
                  className={cn(
                    "flex flex-wrap items-center gap-3 px-4 py-3",
                    !banner.active && "bg-admin-raised/60",
                  )}
                >
                  <span className="flex shrink-0 flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => void onMove(banner.id, "up")}
                      disabled={index === 0 || busy}
                      aria-label={`Move ${banner.title} up`}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-admin-muted transition-colors hover:bg-admin-border hover:text-admin-ink disabled:opacity-25"
                    >
                      <ArrowUp className="h-3 w-3" strokeWidth={2.25} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void onMove(banner.id, "down")}
                      disabled={index === rows.length - 1 || busy}
                      aria-label={`Move ${banner.title} down`}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-admin-muted transition-colors hover:bg-admin-border hover:text-admin-ink disabled:opacity-25"
                    >
                      <ArrowDown className="h-3 w-3" strokeWidth={2.25} />
                    </button>
                  </span>

                  <span className="hidden h-12 w-20 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised sm:block">
                    {banner.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={banner.image} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm font-medium",
                        banner.active ? "text-admin-ink" : "text-admin-muted",
                      )}
                    >
                      {banner.title}
                    </span>
                    <span className="block truncate text-[0.6875rem] text-admin-muted">
                      {banner.subtitle}
                    </span>
                    <span className="mt-0.5 block text-[0.625rem] text-admin-faint">
                      {formatDate(banner.startsAt)} →{" "}
                      {banner.endsAt ? formatDate(banner.endsAt) : "no end"}
                      {banner.buttonText ? ` · ${banner.buttonText} → ${banner.buttonLink}` : ""}
                    </span>
                  </span>

                  {live ? (
                    <StatusBadge tone="good">Live</StatusBadge>
                  ) : banner.active ? (
                    <StatusBadge tone="info">Scheduled</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">Off</StatusBadge>
                  )}

                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => void onToggle(banner)}
                      disabled={busy}
                      aria-label={banner.active ? `Switch off ${banner.title}` : `Switch on ${banner.title}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:opacity-40"
                    >
                      {banner.active ? (
                        <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setEditing({ ...banner })}
                      aria-label={`Edit ${banner.title}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>

                    <button
                      type="button"
                      onClick={() => setPendingDelete(banner)}
                      aria-label={`Delete ${banner.title}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </AdminCard>

      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.title ? "Edit banner" : "Add banner"}
        className="max-w-lg"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <FormGrid>
              <AdminInput
                label="Message"
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                required
                placeholder="Free delivery on orders above ₹999"
                className="sm:col-span-2"
              />

              <AdminInput
                label="Supporting line"
                value={editing.subtitle}
                onChange={(event) => setEditing({ ...editing, subtitle: event.target.value })}
                className="sm:col-span-2"
                hint="Shown in the admin list; the storefront strip uses the message only."
              />

              <AdminInput
                label="Image URL"
                type="url"
                value={editing.image}
                onChange={(event) => setEditing({ ...editing, image: event.target.value })}
                className="sm:col-span-2"
              />

              <AdminInput
                label="Button text"
                value={editing.buttonText}
                onChange={(event) => setEditing({ ...editing, buttonText: event.target.value })}
                placeholder="Shop now"
              />

              <AdminInput
                label="Button link"
                value={editing.buttonLink}
                onChange={(event) => setEditing({ ...editing, buttonLink: event.target.value })}
                placeholder="/shop"
                hint="Must start with a slash."
              />

              <AdminInput
                label="Starts"
                type="date"
                value={toDateInput(editing.startsAt)}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    startsAt: fromDateInput(event.target.value) ?? editing.startsAt,
                  })
                }
              />

              <AdminInput
                label="Ends"
                type="date"
                value={toDateInput(editing.endsAt)}
                onChange={(event) =>
                  setEditing({ ...editing, endsAt: fromDateInput(event.target.value) })
                }
                hint="Blank to run indefinitely."
              />
            </FormGrid>

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={busy} onClick={() => void onSave()}>
                Save banner
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete banner?"
        loading={busy}
        confirmLabel="Delete banner"
        message={
          <>
            Delete <strong className="text-admin-ink">{pendingDelete?.title}</strong>? Switching it
            off keeps the record if you might use it again.
          </>
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
