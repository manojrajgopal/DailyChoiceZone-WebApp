/**
 * Every Zustand store back to its first state, so no test sees another's cart,
 * session or toasts. Called after each test by `setup.ts`.
 */
import { useAdminAuthStore } from "@/store/adminAuthStore";
import { useCartStore } from "@/store/cartStore";
import { useCheckoutStore } from "@/store/checkoutStore";
import { useCompareStore } from "@/store/compareStore";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { useSessionStore } from "@/store/sessionStore";
import { useToastStore } from "@/store/toastStore";
import { useWishlistStore } from "@/store/wishlistStore";

const STORES = [
  useAdminAuthStore,
  useCartStore,
  useCheckoutStore,
  useCompareStore,
  useRecentlyViewedStore,
  useSessionStore,
  useToastStore,
  useWishlistStore,
];

export function resetStores() {
  for (const store of STORES) {
    const resettable = store as unknown as { setState: (state: unknown, replace: true) => void; getInitialState: () => unknown };
    resettable.setState(resettable.getInitialState(), true);
  }
}
