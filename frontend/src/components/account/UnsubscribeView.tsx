"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "@/services/api/client";
import { unsubscribe } from "@/services/messagingService";

const NAMES: Record<string, string> = { email: "emails", sms: "text messages", whatsapp: "WhatsApp messages", in_app: "notifications" };

/** One click from a marketing message: that channel's offers stop. No sign-in needed. */
export function UnsubscribeView() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<{ done: boolean; channel?: string; error?: string } | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    if (!token) {
      setState({ done: false, error: "This unsubscribe link is incomplete." });
      return;
    }
    unsubscribe(token)
      .then((result) => setState({ done: true, channel: result.channel }))
      .catch((error) => setState({ done: false, error: error instanceof ApiError ? error.message : "That didn't work. Please try again." }));
  }, [token]);

  return (
    <div className="page-shell mx-auto max-w-lg py-16 text-center">
      <h1 className="font-display text-3xl text-ink">{state?.done ? "You're unsubscribed" : state?.error ? "We couldn't unsubscribe you" : "Unsubscribing…"}</h1>
      <p className="mt-4 text-sm leading-relaxed text-ink-600">
        {state?.done ? `You won't get marketing ${NAMES[state.channel ?? "email"] ?? "messages"} from us any more. Order updates and account emails still arrive as usual.`
          : state?.error ?? "Just a moment."}
      </p>
      <p className="mt-6 text-sm"><Link href="/account/settings" className="underline underline-offset-4">Manage all your preferences</Link> &middot; <Link href="/" className="underline underline-offset-4">Back to the shop</Link></p>
    </div>
  );
}
