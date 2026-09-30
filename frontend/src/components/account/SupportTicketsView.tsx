"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, MessageSquarePlus, Search } from "lucide-react";

import { listMyTickets, type TicketRow } from "@/services/supportService";

import { AccountShell } from "@/components/account/AccountShell";
import { EmptyState, ErrorState } from "@/components/common/States";
import { ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { CustomerTicketView } from "@/components/support/CustomerTicketView";
import { CustomerStatusBadge } from "@/components/support/SupportParts";
import { useAsync } from "@/hooks/useAsync";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatAgo } from "@/lib/support/format";

const FILTERS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "in-progress", label: "In progress" },
  { value: "waiting", label: "Waiting for you" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

/** "My support requests": every request the customer has raised, newest activity first. */
export function SupportTicketsView() {
  const { isSignedIn } = useSession();
  const [filter, setFilter] = useState("");
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");

  // Search as they type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term]);

  const { data, error, isLoading, reload } = useAsync(() => listMyTickets(filter, search), [filter, search, isSignedIn], {
    enabled: isSignedIn,
  });

  return (
    <AccountShell
      title="Support requests"
      description="Every request you've raised with us, and the conversation on each."
      breadcrumb={[{ label: "Support requests" }]}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <label htmlFor="ticket-search" className="sr-only">
            Search your requests
          </label>
          <input
            id="ticket-search"
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Request number, subject or order"
            className="h-11 w-full rounded-control border border-ink-200 bg-shell pl-9 pr-3 text-sm text-ink placeholder:text-ink-400 hover:border-ink-300 focus:border-copper-500"
          />
        </div>
        <ButtonLink href="/contact" size="sm">
          <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          New request
        </ButtonLink>
      </div>

      <div
        role="tablist"
        aria-label="Filter requests"
        className="no-scrollbar -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {FILTERS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={filter === entry.value}
            onClick={() => setFilter(entry.value)}
            className={cn(
              "shrink-0 rounded-pill border px-3.5 py-1.5 text-sm transition-colors",
              filter === entry.value
                ? "border-ink bg-ink text-cream"
                : "border-ink-200 text-ink-700 hover:border-ink-400 hover:text-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {isLoading && !data ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your requests">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-28 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState description="We couldn't load your requests just now." onRetry={reload} />
        ) : !data || data.length === 0 ? (
          search || filter ? (
            <EmptyState
              icon="search"
              title="No requests match"
              description="Try a different filter or search."
              secondaryAction={{
                label: "Show all",
                onClick: () => {
                  setFilter("");
                  setTerm("");
                },
              }}
            />
          ) : (
            <EmptyState
              title="No requests yet"
              description="When you contact us, your request and our replies appear here."
              action={{ label: "Contact us", href: "/contact" }}
            />
          )
        ) : (
          <ul className={cn("flex flex-col gap-3", isLoading && "opacity-60")}>
            {data.map((ticket) => (
              <li key={ticket.id}>
                <TicketCard ticket={ticket} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AccountShell>
  );
}

function TicketCard({ ticket }: { ticket: TicketRow }) {
  const path = [ticket.category, ticket.subcategory].filter(Boolean).join(" › ");
  return (
    <Link
      href={`/account/ticket?number=${encodeURIComponent(ticket.number)}`}
      className="group block rounded-card border border-ink-200 bg-shell p-4 transition-colors hover:border-ink sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs text-ink-500">
            <span className="font-medium tabular-nums text-ink-700">{ticket.number}</span>
            {ticket.channel === "chat" ? <span className="rounded-control bg-cream-deep px-1.5 py-0.5">Chat</span> : null}
            {ticket.unread > 0 ? (
              <span className="inline-flex items-center gap-1 font-medium text-copper-700">
                <span className="h-1.5 w-1.5 rounded-pill bg-copper-600" aria-hidden="true" />
                {ticket.unread} new {ticket.unread === 1 ? "reply" : "replies"}
              </span>
            ) : null}
          </p>
          <p className="mt-1.5 font-display text-base leading-snug text-ink">{ticket.subject}</p>
          <p className="mt-0.5 text-xs text-ink-500">
            {path}
            {ticket.orderNumber ? ` · Order ${ticket.orderNumber}` : ""}
          </p>
        </div>
        <CustomerStatusBadge status={ticket.status} label={ticket.statusLabel} />
      </div>

      {ticket.lastMessage ? <p className="mt-3 line-clamp-2 text-sm text-ink-600">{ticket.lastMessage}</p> : null}

      <p className="mt-3.5 flex items-center justify-between gap-3 border-t border-ink-100 pt-3 text-xs">
        <span className="text-ink-500">
          {ticket.priority === "urgent" || ticket.priority === "high" ? (
            <span className="mr-2 font-medium text-clay-600">{ticket.priority === "urgent" ? "Urgent" : "High priority"}</span>
          ) : null}
          Updated {formatAgo(ticket.updatedAt)}
        </span>
        <span className="inline-flex items-center gap-1.5 text-copper-700">
          Open
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform duration-200 ease-brand group-hover:translate-x-0.5"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </span>
      </p>
    </Link>
  );
}

/** One request, inside the account: `/account/ticket?number=DCZ-2026-000123`. */
export function AccountTicketView() {
  const number = useSearchParams().get("number") ?? "";
  return (
    <AccountShell
      title="Support request"
      breadcrumb={[{ label: "Support requests", href: "/account/support" }, { label: number || "Request" }]}
    >
      {number ? (
        <CustomerTicketView number={number} ticketKey={null} backHref="/account/support" />
      ) : (
        <EmptyState title="No request chosen" action={{ label: "Your requests", href: "/account/support" }} />
      )}
    </AccountShell>
  );
}
