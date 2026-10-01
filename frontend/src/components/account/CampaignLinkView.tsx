"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { followCampaignLink } from "@/services/messagingService";

/**
 * A link from a campaign: the click is recorded, then the shopper moves on.
 * The destination must carry the server's signature — this page can't be used
 * to send anyone anywhere else.
 */
export function CampaignLinkView({ token }: { token: string }) {
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const to = params.get("to") ?? "";
    const signature = params.get("s") ?? "";
    followCampaignLink(token, to, signature)
      .then(({ url }) => window.location.replace(url))
      .catch(() => setFailed(true));
  }, [params, token]);

  return (
    <div className="page-shell py-20 text-center text-sm text-ink-500">
      {failed ? <p>This link isn&rsquo;t valid. <Link href="/" className="underline underline-offset-4">Go to the shop</Link></p> : <p>Taking you there…</p>}
    </div>
  );
}
