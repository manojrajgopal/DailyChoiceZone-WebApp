import type { Metadata } from "next";

import { FlashSalesView } from "@/components/growth/FlashSales";

export const metadata: Metadata = {
  title: "Flash sales",
  description: "Limited-time prices at Daily Choice Zone, while sale stock lasts.",
};

export default function Page() {
  return <FlashSalesView />;
}
