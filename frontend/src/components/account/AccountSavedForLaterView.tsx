"use client";

import { AccountShell } from "@/components/account/AccountShell";
import { SavedForLaterSection } from "@/components/cart/SavedForLaterSection";
import { EmptyState } from "@/components/common/States";
import { announceItemCount } from "@/hooks/useCart";
import { useSavedForLater } from "@/hooks/useSavedForLater";

/**
 * Saved for later, inside the account area — the lines put aside from the bag.
 * Different from the wishlist on purpose: these keep their size, colour and
 * quantity, and go back to the bag, not to a product page.
 */
export function AccountSavedForLaterView() {
  // The bag isn't shown here, so a move only needs to update the header badge —
  // not read and price the whole bag.
  const saved = useSavedForLater({ onCart: (cart) => announceItemCount(cart.breakdown.itemCount) });

  return (
    <AccountShell
      title="Saved for later"
      description="Items you took out of your bag to buy another time."
      breadcrumb={[{ label: "Saved for later" }]}
    >
      {!saved.isLoading && !saved.failed && saved.count === 0 ? (
        <EmptyState
          title="Nothing saved for later"
          description="In your bag, choose “Save for later” on anything you'd rather not buy just yet."
          action={{ label: "Go to your bag", href: "/cart" }}
        />
      ) : (
        <SavedForLaterSection
          heading="Your saved items"
          entries={saved.entries}
          isLoading={saved.isLoading}
          failed={saved.failed}
          busy={saved.busy}
          onMoveToCart={(entry) => void saved.moveToCart(entry)}
          onRemove={(entry) => void saved.remove(entry)}
          onClear={saved.clear}
          onRetry={saved.refresh}
        />
      )}
    </AccountShell>
  );
}
