"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Heart, LogOut, MapPin, Package, Settings, User } from "lucide-react";

import { AuthPanel } from "@/components/account/AuthPanel";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";

const NAV = [
  { href: "/account", label: "Profile", icon: User },
  { href: "/account/orders", label: "Orders", icon: Package },
  { href: "/account/invoices", label: "Invoices", icon: FileText },
  { href: "/account/addresses", label: "Addresses", icon: MapPin },
  { href: "/wishlist", label: "Wishlist", icon: Heart },
  { href: "/account/settings", label: "Settings", icon: Settings },
] as const;

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

      <div className="mt-9 grid items-start gap-9 lg:grid-cols-[14rem_1fr] lg:gap-12">
        {/* ------------------------------------------------------- sidebar */}
        <aside>
          <div className="rounded-card border border-ink-200 bg-shell p-4">
            <p className="font-display text-base text-ink">
              {user.firstName} {user.lastName}
            </p>
            <p className="mt-0.5 truncate text-xs text-ink-500">{user.email}</p>
            <p className="mt-2 text-[0.6875rem] text-ink-400">
              Member since {formatDate(user.memberSince)}
            </p>
          </div>

          <nav aria-label="Account" className="mt-4">
            <ul className="flex flex-col">
              {NAV.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 border-l-2 py-2.5 pl-3.5 text-sm transition-colors",
                        active
                          ? "border-ink bg-cream-deep font-medium text-ink"
                          : "border-transparent text-ink-700 hover:border-ink-300 hover:text-ink",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}

              <li>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="flex w-full items-center gap-2.5 border-l-2 border-transparent py-2.5 pl-3.5 text-left text-sm text-ink-700 transition-colors hover:border-ink-300 hover:text-ink"
                >
                  <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  Sign out
                </button>
              </li>
            </ul>
          </nav>
        </aside>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
