"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { ChannelPreferencesSection } from "@/components/account/ChannelPreferencesSection";
import { SecuritySettings } from "@/components/account/SecuritySettings";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils/cn";
import {
  getEmailPreferences,
  saveEmailPreferences,
  type EmailPreference,
} from "@/services/emailSettingsService";
import { useCartStore } from "@/store/cartStore";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { useWishlistStore } from "@/store/wishlistStore";
import { toast } from "@/store/toastStore";

/**
 * Account settings.
 *
 * Email preferences follow the account: they list only the emails the store
 * actually sends, and each change is saved as it is made. Emails the store
 * requires (an order confirmation, say) are shown switched on and cannot be
 * turned off. The data controls underneath clear exactly what this site has
 * stored in this browser, and leave the account untouched.
 */
export function SettingsView() {
  const clearCart = useCartStore((state) => state.clearCart);
  const clearWishlist = useWishlistStore((state) => state.clear);
  const clearRecentlyViewed = useRecentlyViewedStore((state) => state.clear);

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
      description="How you sign in, your email preferences and the items saved on this device."
      breadcrumb={[{ label: "Settings" }]}
    >
      {/* -------------------------------------------------------- security */}
      <SecuritySettings />

      {/* --------------------------------------------------- notifications */}
      <EmailPreferencesSection />
      <ChannelPreferencesSection />

      {/* ------------------------------------------------------ local data */}
      <section className="mt-5 rounded-card border border-ink-200 bg-shell p-5">
        <h2 className="label-wide text-ink">Saved on this device</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-700">
          This browser keeps a few things for convenience: a bag and wishlist saved before you
          signed in, the checkout details you are part-way through, and the products you recently
          viewed. Your account, orders, invoices and addresses are kept safely with your account and won&rsquo;t be affected.
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

/* ----------------------------------------------------- email preferences */

/**
 * The customer's email choices, saved on every toggle.
 *
 * Rendered inside the account shell, so preferences are only requested once
 * the customer is signed in.
 */
function EmailPreferencesSection() {
  const [prefs, setPrefs] = useState<EmailPreference[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = async () => {
    setFailed(false);
    try {
      setPrefs(await getEmailPreferences());
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    let active = true;
    getEmailPreferences()
      .then((list) => active && setPrefs(list))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const onToggle = async (key: string, enabled: boolean) => {
    if (!prefs) return;
    const previous = prefs;
    // Show the change straight away; put it back if it can't be saved.
    setPrefs(prefs.map((pref) => (pref.key === key ? { ...pref, enabled } : pref)));
    setSavingKey(key);
    try {
      setPrefs(await saveEmailPreferences({ [key]: enabled }));
      toast.success("Your email preferences are saved");
    } catch (error) {
      setPrefs(previous);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "We couldn't save that change. Please try again.",
      );
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <section className="rounded-card border border-ink-200 bg-shell p-5">
      <h2 className="label-wide text-ink">Email preferences</h2>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        Choose the emails you&rsquo;d like to receive from us. Changes are saved straight away.
      </p>

      {prefs === null && !failed ? (
        <div className="mt-4 flex flex-col gap-3" role="status" aria-label="Loading your email preferences">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-start gap-2.5">
              <Skeleton className="h-[1.125rem] w-[1.125rem] shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-48 max-w-full" />
                <Skeleton className="mt-1.5 h-3 w-full max-w-sm" />
              </div>
            </div>
          ))}
        </div>
      ) : prefs === null ? (
        <div className="mt-4">
          <p className="text-sm text-ink-700">
            We couldn&rsquo;t load your email preferences just now.
          </p>
          <Button variant="outline" className="mt-3" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : prefs.length === 0 ? (
        <p className="mt-4 text-sm text-ink-700">
          We&rsquo;ll let you know here when there are emails to manage.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {prefs.map((pref) => {
            const disabled = pref.locked || savingKey !== null;
            const noteId = `email-pref-${pref.key}-note`;
            return (
              <li key={pref.key}>
                <label
                  className={cn(
                    "flex items-start gap-2.5",
                    disabled ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                >
                  <span className="relative mt-0.5 inline-flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center">
                    <input
                      type="checkbox"
                      checked={pref.locked || pref.enabled}
                      disabled={disabled}
                      aria-describedby={noteId}
                      onChange={(event) => void onToggle(pref.key, event.target.checked)}
                      className="peer h-full w-full cursor-pointer appearance-none rounded-[2px] border border-ink-300 bg-shell transition-colors checked:border-ink checked:bg-ink disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <Check
                      className="pointer-events-none absolute h-3 w-3 text-cream opacity-0 transition-opacity peer-checked:opacity-100"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm text-ink-700">
                      {pref.label}
                      {savingKey === pref.key ? (
                        <Loader2 className="h-3 w-3 animate-spin text-ink-400" aria-label="Saving" />
                      ) : null}
                    </span>
                    <span id={noteId} className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                      {pref.description}
                      {pref.locked ? (
                        <span className="mt-0.5 block text-[0.6875rem] text-ink-400">
                          Always sent
                        </span>
                      ) : null}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
