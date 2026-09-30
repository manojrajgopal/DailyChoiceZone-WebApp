"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/common/States";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Skeleton } from "@/components/ui/Skeleton";

import { CustomerTicketView } from "./CustomerTicketView";

const STORE_KEY = (number: string) => `dcz:ticket-key:${number}`;

/**
 * A request opened from the link in its emails: `/support/ticket?number=…&key=…`.
 *
 * The key is moved out of the address bar as soon as the page loads — into
 * this tab's session storage — so it doesn't linger in history, get shared
 * with a copied URL, or leave in a Referer header. From then on it travels
 * only in the `X-Ticket-Key` header.
 */
export function GuestTicketView() {
  const router = useRouter();
  const params = useSearchParams();
  const number = params.get("number") ?? "";
  const fromUrl = params.get("key");
  const [key, setKey] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!number) return;
    let stored: string | null = null;
    try {
      if (fromUrl) window.sessionStorage.setItem(STORE_KEY(number), fromUrl);
      stored = window.sessionStorage.getItem(STORE_KEY(number));
    } catch {
      // Storage blocked: keep the key in memory for this visit.
    }
    setKey(fromUrl || stored);
    if (fromUrl) router.replace(`/support/ticket?number=${encodeURIComponent(number)}`, { scroll: false });
  }, [number, fromUrl, router]);

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Contact us", href: "/contact" }, { label: number || "Request" }]} />
      <h1 className="mt-4 font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">Your request</h1>
      <div className="mt-6">
        {!number ? (
          <EmptyState title="No request chosen" description="Open the link in the email we sent you." action={{ label: "Contact us", href: "/contact" }} />
        ) : key === undefined ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <CustomerTicketView number={number} ticketKey={key} />
        )}
      </div>
    </div>
  );
}
