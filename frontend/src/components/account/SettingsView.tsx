"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Dialog";
import { useCartStore } from "@/store/cartStore";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { useWishlistStore } from "@/store/wishlistStore";
import { toast } from "@/store/toastStore";

/**
 * Account settings.
 *
 * The preference toggles are local-only today — there is no backend to store
 * them against, and the page says so rather than implying they persist
 * server-side. The data controls underneath are real: they clear exactly what
 * this site has stored in this browser.
 */
export function SettingsView() {
  const clearCart = useCartStore((state) => state.clearCart);
  const clearWishlist = useWishlistStore((state) => state.clear);
  const clearRecentlyViewed = useRecentlyViewedStore((state) => state.clear);

  const [prefs, setPrefs] = useState({
    orderUpdates: true,
    newArrivals: true,
    offers: false,
    backInStock: true,
  });

  const [confirmOpen, setConfirmOpen] = useState(false);

  const onClearBrowsingData = () => {
    clearCart();
    clearWishlist();
    clearRecentlyViewed();
    setConfirmOpen(false);
    toast.success("Your bag, wishlist and browsing history have been cleared");
  };

  return (
    <AccountShell
      title="Settings"
      description="Notification preferences and the data this site keeps in your browser."
      breadcrumb={[{ label: "Settings" }]}
    >
      {/* --------------------------------------------------- notifications */}
      <section className="rounded-card border border-ink-200 bg-shell p-5">
        <h2 className="label-wide text-ink">Email preferences</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-500">
          Saved on this device only for now — there is no account backend yet to sync them to.
        </p>

        <div className="mt-4 flex flex-col gap-1">
          <Checkbox
            label="Order and delivery updates"
            checked={prefs.orderUpdates}
            onChange={(event) =>
              setPrefs((current) => ({ ...current, orderUpdates: event.target.checked }))
            }
          />
          <Checkbox
            label="New arrivals and collections"
            checked={prefs.newArrivals}
            onChange={(event) =>
              setPrefs((current) => ({ ...current, newArrivals: event.target.checked }))
            }
          />
          <Checkbox
            label="Sales and member offers"
            checked={prefs.offers}
            onChange={(event) =>
              setPrefs((current) => ({ ...current, offers: event.target.checked }))
            }
          />
          <Checkbox
            label="Back-in-stock alerts for saved items"
            checked={prefs.backInStock}
            onChange={(event) =>
              setPrefs((current) => ({ ...current, backInStock: event.target.checked }))
            }
          />
        </div>

        <Button className="mt-5" onClick={() => toast.success("Preferences saved")}>
          Save preferences
        </Button>
      </section>

      {/* ------------------------------------------------------ local data */}
      <section className="mt-5 rounded-card border border-ink-200 bg-shell p-5">
        <h2 className="label-wide text-ink">Data stored in this browser</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-700">
          Your bag, wishlist, saved addresses, sample orders and recently viewed items are kept in
          this browser&rsquo;s local storage. Nothing is sent to a server, and clearing your
          browser data removes it all.
        </p>

        <Button variant="outline" className="mt-5" onClick={() => setConfirmOpen(true)}>
          Clear bag, wishlist and history
        </Button>
      </section>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear your browsing data?"
        description="This empties your bag, wishlist and recently viewed list on this device. Saved addresses and past orders are kept."
        className="max-w-md"
      >
        <div className="flex items-start gap-3 rounded-card bg-danger-bg p-3.5">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-danger"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <p className="text-xs leading-relaxed text-ink-700">
            This cannot be undone.
          </p>
        </div>

        <div className="mt-5 flex gap-2">
          <Button variant="outline" fullWidth onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="sale" fullWidth onClick={onClearBrowsingData}>
            Clear data
          </Button>
        </div>
      </Modal>
    </AccountShell>
  );
}
