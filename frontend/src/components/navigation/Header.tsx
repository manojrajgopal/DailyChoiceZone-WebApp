"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Heart, Menu, Search, ShoppingBag, User } from "lucide-react";

import type { NavItem } from "@/types";

import { Logo } from "@/components/common/Logo";
import { useCartCount } from "@/hooks/useCart";
import { useWishlistCount } from "@/hooks/useWishlist";
import { cn } from "@/lib/utils/cn";

import { MegaMenu } from "./MegaMenu";
import { MobileNav } from "./MobileNav";
import { SearchOverlay } from "./SearchOverlay";

/**
 * The site header.
 *
 * Mega-menu behaviour is the fiddly part, and it is handled deliberately:
 *
 * - Opens on pointer enter and on keyboard focus, so it is reachable without a
 *   mouse.
 * - Closes on Escape, on pointer leave of the whole header region, and on
 *   navigation.
 * - Closing on leave is debounced by a short timer, because the gap between a
 *   trigger and its panel would otherwise close the menu mid-travel — the
 *   single most common mega-menu bug.
 */
export function Header({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cartCount = useCartCount();
  const wishlistCount = useWishlistCount();

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenMenuId(null), 140);
  };

  const openMenu = (id: string) => {
    cancelClose();
    setOpenMenuId(id);
  };

  useEffect(() => cancelClose, []);

  // Any navigation closes every overlay.
  useEffect(() => {
    setOpenMenuId(null);
    setMobileOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!openMenuId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openMenuId]);

  const activeItem = items.find((item) => item.id === openMenuId) ?? null;

  const iconButton =
    "relative inline-flex h-10 w-10 items-center justify-center rounded-pill text-ink transition-colors hover:bg-cream-deep";

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-ink-200 bg-cream/95 backdrop-blur-md">
        <div
          onPointerLeave={scheduleClose}
          onPointerEnter={cancelClose}
        >
          <div className="page-shell flex h-16 items-center gap-3 sm:h-[4.5rem]">
            {/* ------------------------------------------- mobile: hamburger */}
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              className={cn(iconButton, "-ml-2 lg:hidden")}
            >
              <Menu className="h-5 w-5" strokeWidth={1.5} />
            </button>

            <Logo className="shrink-0" />

            {/* ---------------------------------------------- desktop: nav */}
            <nav aria-label="Main" className="ml-6 hidden flex-1 lg:block">
              <ul className="flex items-center gap-1">
                {items.map((item) => {
                  const isOpen = openMenuId === item.id;
                  const hasMenu = Boolean(item.columns?.length);

                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        onPointerEnter={() => (hasMenu ? openMenu(item.id) : setOpenMenuId(null))}
                        onFocus={() => (hasMenu ? openMenu(item.id) : setOpenMenuId(null))}
                        aria-expanded={hasMenu ? isOpen : undefined}
                        className={cn(
                          "relative inline-flex items-center px-3 py-2 label-wide transition-colors",
                          item.highlight ? "text-clay-500 hover:text-clay-600" : "text-ink hover:text-copper-700",
                        )}
                      >
                        {item.label}
                        {/* Underline grows from the centre on hover and while open. */}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "absolute inset-x-3 -bottom-0.5 h-px origin-center scale-x-0 bg-current transition-transform duration-200 ease-brand",
                            isOpen && "scale-x-100",
                          )}
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {/* ------------------------------------------------- utilities */}
            <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label="Search"
                className={iconButton}
              >
                <Search className="h-5 w-5" strokeWidth={1.5} />
              </button>

              <Link
                href="/account"
                aria-label="Account"
                className={cn(iconButton, "hidden sm:inline-flex")}
              >
                <User className="h-5 w-5" strokeWidth={1.5} />
              </Link>

              <Link href="/wishlist" aria-label={`Wishlist, ${wishlistCount} items`} className={iconButton}>
                <Heart className="h-5 w-5" strokeWidth={1.5} />
                {wishlistCount > 0 ? <CountBadge value={wishlistCount} /> : null}
              </Link>

              <Link
                href="/cart"
                aria-label={`Shopping bag, ${cartCount} items`}
                className={cn(iconButton, "-mr-2")}
              >
                <ShoppingBag className="h-5 w-5" strokeWidth={1.5} />
                {cartCount > 0 ? <CountBadge value={cartCount} /> : null}
              </Link>
            </div>
          </div>

          {/* ------------------------------------------------- mega menu --- */}
          {activeItem ? (
            <div className="absolute inset-x-0 top-full hidden lg:block">
              <MegaMenu item={activeItem} onNavigate={() => setOpenMenuId(null)} />
            </div>
          ) : null}
        </div>
      </header>

      <MobileNav open={mobileOpen} onOpenChange={setMobileOpen} items={items} />
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

/** The little count bubble on the wishlist and bag icons. */
function CountBadge({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-clay-500 px-1 text-[0.625rem] font-medium leading-none text-white tabular-nums"
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}
