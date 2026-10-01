"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Award, BellRing, Crown, FileText, Gift, Heart, LifeBuoy, LogOut, MapPin, Package, Settings, User, Wallet } from "lucide-react";

import { VerifyEmailBanner } from "@/components/account/AccountRecovery";
import { AuthPanel } from "@/components/account/AuthPanel";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import { useSiteContent } from "@/hooks/useSiteContent";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";

/**
 * Icons, by the name the API uses.
 *
 * The menu itself is configuration and comes from the store; only the drawing
 * of each entry lives here, because an API cannot send a React component.
 */
const ICONS: Record<string, typeof User> = {
  user: User,
  package: Package,
  "file-text": FileText,
  "map-pin": MapPin,
  heart: Heart,
  crown: Crown,
  settings: Settings,
  "life-buoy": LifeBuoy,
  bell: BellRing,
  wallet: Wallet,
  award: Award,
  gift: Gift,
};

/** Account pages added after the menu document was first saved. */
const ADDED_ENTRIES = [
  { after: "/account/wishlist", entry: { href: "/account/membership", label: "Membership", icon: "crown" } },
  { after: "/account/orders", entry: { href: "/account/support", label: "Support requests", icon: "life-buoy" } },
  { after: "/account/membership", entry: { href: "/account/rewards", label: "Reward points", icon: "award" } },
  { after: "/account/rewards", entry: { href: "/account/wallet", label: "Gift cards & credit", icon: "wallet" } },
  { after: "/account/wishlist", entry: { href: "/account/alerts", label: "Stock & price alerts", icon: "bell" } },
  { after: "/account/wallet", entry: { href: "/account/referrals", label: "Refer a friend", icon: "gift" } },
];

/**
 * The frame for every account page.
 *
 * It also acts as the auth gate: signed out, the whole area is replaced by the
 * sign-in panel rather than each page checking for itself. That keeps the
 * signed-out experience consistent and impossible to forget.
 */
export function AccountShell({
  title,
  description,
  breadcrumb,
  children,
}: {
  title: string;
  description?: string;
  /** Extra crumbs after "Account", e.g. an order number. */
  breadcrumb?: { label: string; href?: string }[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { user, isSignedIn, isLoading, signOut } = useSession();
  // The menu is a content document an administrator can edit. Stores set up
  // before the account wishlist existed link "/wishlist" (the full page); inside
  // the account area it opens the account preview instead, which links on.
  const remapped = (useSiteContent()?.accountNavigation ?? []).map((item) =>
    item.href === "/wishlist" ? { ...item, href: "/account/wishlist" } : item,
  );
  // Menus saved before memberships and support requests existed have no
  // entry for them: add each after its neighbour (or at the end), unless the
  // store already lists it.
  const accountNav = ADDED_ENTRIES.reduce((items, { after, entry }) => {
    if (items.length === 0 || items.some((item) => item.href === entry.href)) return items;
    const anchor = items.findIndex((item) => item.href === after);
    const at = anchor === -1 ? items.length : anchor + 1;
    return [...items.slice(0, at), entry, ...items.slice(at)];
  }, remapped);

  if (isLoading) {
    return (
      <div className="page-shell py-10">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-5 h-9 w-64" />
        <div className="mt-10 grid gap-10 lg:grid-cols-[14rem_1fr]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!isSignedIn || !user) {
    return (
      <div className="page-shell py-10 sm:py-14">
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Account" }]} />
        <h1 className="mt-4 text-center font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">
          Your account
        </h1>
        <p className="mx-auto mt-2.5 max-w-md text-center text-sm leading-relaxed text-ink-500">
          Sign in to track orders, save addresses and keep your wishlist across visits.
        </p>
        <div className="mt-10">
          <AuthPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          ...(breadcrumb
            ? [{ label: "Account", href: "/account" }, ...breadcrumb]
            : [{ label: "Account" }]),
        ]}
      />

      <div className="mt-4">
        <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-2.5 text-sm leading-relaxed text-ink-500">{description}</p>
        ) : null}
      </div>

      <div className="mt-6 grid items-start gap-6 lg:mt-9 lg:grid-cols-[14rem_1fr] lg:gap-12">
        {/* ------------------------------------------------------- sidebar */}
        {/*
          Below 1024px the sidebar becomes one swipeable row of tabs. Stacked,
          it was eight rows and a card between the page title and the content,
          on every account page.
        */}
        <aside className="min-w-0">
          <div className="hidden rounded-card border border-ink-200 bg-shell p-4 lg:block">
            <p className="font-display text-base text-ink">
              {user.firstName} {user.lastName}
            </p>
            <p className="mt-0.5 truncate text-xs text-ink-500">{user.email}</p>
            <p className="mt-2 text-[0.6875rem] text-ink-400">
              Member since {formatDate(user.memberSince)}
            </p>
          </div>

          <nav aria-label="Account" className="lg:mt-4">
            <ul className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto scroll-px-4 px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:flex-col lg:gap-0 lg:overflow-visible lg:px-0 lg:pb-0">
              {accountNav.map((item) => {
                const active =
                  pathname === item.href || (item.href === "/account/support" && pathname === "/account/ticket");
                const Icon = ICONS[item.icon] ?? User;
                return (
                  <li key={item.href} className="shrink-0 lg:shrink">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2 whitespace-nowrap rounded-pill border px-3.5 py-2 text-sm transition-colors",
                        "lg:gap-2.5 lg:rounded-none lg:border-0 lg:border-l-2 lg:py-2.5 lg:pl-3.5 lg:pr-0",
                        active
                          ? "border-ink bg-ink font-medium text-cream lg:border-ink lg:bg-cream-deep lg:text-ink"
                          : "border-ink-200 text-ink-700 hover:border-ink-400 hover:text-ink lg:border-transparent lg:hover:border-ink-300",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}

              <li className="shrink-0 lg:shrink">
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="flex w-full items-center gap-2 whitespace-nowrap rounded-pill border border-ink-200 px-3.5 py-2 text-left text-sm text-ink-700 transition-colors hover:border-ink-400 hover:text-ink lg:gap-2.5 lg:rounded-none lg:border-0 lg:border-l-2 lg:border-transparent lg:py-2.5 lg:pl-3.5 lg:hover:border-ink-300"
                >
                  <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  Sign out
                </button>
              </li>
            </ul>
          </nav>
        </aside>

        <div className="min-w-0">
          {user.emailVerified === false ? <VerifyEmailBanner email={user.email} /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
