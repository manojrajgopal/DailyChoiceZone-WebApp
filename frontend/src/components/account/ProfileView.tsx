"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Heart, MapPin, Package } from "lucide-react";

import type { Order } from "@/types";

import { AccountShell } from "@/components/account/AccountShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useSession } from "@/hooks/useSession";
import { useWishlistCount } from "@/hooks/useWishlist";
import { getAddresses } from "@/services/accountService";
import { getOrders } from "@/services/orderService";
import { formatDate, formatPrice } from "@/lib/utils/format";

/** The account overview: editable profile plus at-a-glance counts. */
export function ProfileView() {
  const { user, isSignedIn, updateProfile } = useSession();
  const wishlistCount = useWishlistCount();

  const [orders, setOrders] = useState<Order[]>([]);
  const [addressCount, setAddressCount] = useState(0);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string>();

  useEffect(() => {
    if (!isSignedIn) return;
    let active = true;

    Promise.all([getOrders(), getAddresses()])
      .then(([orderList, addresses]) => {
        if (!active) return;
        setOrders(orderList);
        setAddressCount(addresses.length);
      })
      .catch(() => {
        if (active) setOrders([]);
      });

    return () => {
      active = false;
    };
  }, [isSignedIn]);

  // Seed the form once the session has hydrated.
  useEffect(() => {
    setFirstName((current) => current || user?.firstName || "");
    setLastName((current) => current || user?.lastName || "");
    setPhone((current) => current || user?.phone || "");
  }, [user?.firstName, user?.lastName, user?.phone]);

  const onSave = (event: React.FormEvent) => {
    event.preventDefault();

    if (phone.trim() !== "" && !/^[6-9]\d{9}$/.test(phone.replace(/\D/g, ""))) {
      setPhoneError("Enter a 10-digit mobile number, or leave it blank.");
      return;
    }

    setPhoneError(undefined);
    updateProfile({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.replace(/\D/g, ""),
    });
  };

  const lastOrder = orders[0];

  return (
    <AccountShell
      title="Your profile"
      description="Your details, orders and saved addresses in one place."
    >
      {/* ------------------------------------------------------ quick stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          href="/account/orders"
          icon={<Package className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          label="Orders"
          value={orders.length}
        />
        <StatCard
          href="/account/addresses"
          icon={<MapPin className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          label="Saved addresses"
          value={addressCount}
        />
        <StatCard
          href="/wishlist"
          icon={<Heart className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          label="Wishlist"
          value={wishlistCount}
        />
      </div>

      {/* ------------------------------------------------------- last order */}
      {lastOrder ? (
        <section className="mt-8 rounded-card border border-ink-200 bg-shell p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="label-wide text-ink">Most recent order</h2>
            <Link
              href={`/account/order?number=${lastOrder.orderNumber}`}
              className="inline-flex items-center gap-1.5 text-xs text-copper-700 transition-colors hover:text-ink"
            >
              View details
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            </Link>
          </div>

          <p className="mt-3 text-sm text-ink">
            {lastOrder.orderNumber} &middot; {formatDate(lastOrder.placedAt)}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {lastOrder.lines.length} {lastOrder.lines.length === 1 ? "item" : "items"} &middot;{" "}
            {formatPrice(lastOrder.totals.total)} &middot; arriving{" "}
            {lastOrder.expectedDelivery}
          </p>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- profile */}
      <section className="mt-8">
        <h2 className="label-wide mb-4 text-ink">Personal details</h2>

        <form onSubmit={onSave} className="max-w-xl">
          <div className="grid gap-5 sm:grid-cols-2">
            <Input
              label="First name"
              autoComplete="given-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
            <Input
              label="Last name"
              autoComplete="family-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
            <Input
              label="Email address"
              type="email"
              value={user?.email ?? ""}
              disabled
              hint="Email cannot be changed in this demo."
              className="sm:col-span-2"
            />
            <Input
              label="Mobile number"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setPhoneError(undefined);
              }}
              error={phoneError}
              placeholder="98765 43210"
              className="sm:col-span-2"
            />
          </div>

          <Button type="submit" className="mt-6">
            Save changes
          </Button>
        </form>
      </section>
    </AccountShell>
  );
}

function StatCard({
  href,
  icon,
  label,
  value,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-card border border-ink-200 bg-shell p-4 transition-colors hover:border-ink"
    >
      <span>
        <span className="flex items-center gap-2 label-wide text-ink-500">
          {icon}
          {label}
        </span>
        <span className="mt-2 block font-display text-2xl text-ink tabular-nums">{value}</span>
      </span>
      <ArrowRight
        className="h-4 w-4 shrink-0 text-ink-300 transition-transform duration-200 ease-brand group-hover:translate-x-0.5 group-hover:text-ink"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    </Link>
  );
}
