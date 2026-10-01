import type { Metadata } from "next";

import { GiftCardPurchaseView } from "@/components/wallet/GiftCardPurchaseView";

export const metadata: Metadata = {
  title: "Gift cards",
  description: "Send a Daily Choice Zone gift card by email — they choose what they love.",
  alternates: { canonical: "/gift-cards" },
};

export default function GiftCardsPage() {
  return <GiftCardPurchaseView />;
}
