import type { Metadata } from "next";
import { Suspense } from "react";

import { CampaignLinkView } from "@/components/account/CampaignLinkView";

export const metadata: Metadata = { title: "Daily Choice Zone", robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Suspense fallback={null}>
      <CampaignLinkView token={token} />
    </Suspense>
  );
}
