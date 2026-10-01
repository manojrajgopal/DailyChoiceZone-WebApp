import type { Metadata } from "next";

import { BundleDetailView } from "@/components/growth/Bundles";

export const metadata: Metadata = { title: "Bundle" };

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <BundleDetailView slug={slug} />;
}
