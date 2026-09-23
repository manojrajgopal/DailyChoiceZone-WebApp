import type { Metadata } from "next";
import Link from "next/link";

import { ContentPage } from "@/components/layout/ContentPage";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Terms & conditions",
  description:
    "The terms that apply when you shop with Daily Choice Zone: orders, pricing, delivery, returns and liability.",
  alternates: { canonical: "/terms" },
};

export default async function TermsPage() {
  const config = await getSiteConfig();

  return (
    <ContentPage
      title="Terms & conditions"
      intro="The terms that apply when you buy from Daily Choice Zone."
      updated="21 September 2026"
    >
      <section>
        <h2>Please note</h2>
        <p>
          This storefront is a demonstration. It has no payment gateway connected, no orders are
          fulfilled and no money changes hands. The terms below describe how the live store will
          operate, and are not a binding contract in its current state.
        </p>
      </section>

      <section>
        <h2>1. Who we are</h2>
        <p>
          {config.name} is operated by Daily Choice Zone Retail Pvt. Ltd., registered in
          Bengaluru, Karnataka, India. Contact:{" "}
          <a href={`mailto:${config.support.email}`}>{config.support.email}</a>.
        </p>
      </section>

      <section>
        <h2>2. Orders</h2>
        <p>
          Placing an order is an offer to buy, not a completed sale. The contract forms when we
          confirm dispatch. We may decline an order — and will always say why — where an item is
          genuinely out of stock, where a price was listed in error, or where we suspect fraud.
        </p>
      </section>

      <section>
        <h2>3. Pricing</h2>
        <p>
          All prices are in Indian Rupees and include applicable taxes. Where a product shows a
          reduction, the higher figure is a price the item was genuinely offered at — we do not
          invent inflated list prices to make a discount look larger.
        </p>
        <p>
          If a pricing error is obvious and significant, we will contact you before dispatching
          rather than quietly cancelling, and you may confirm at the corrected price or have a full
          refund.
        </p>
      </section>

      <section>
        <h2>4. Delivery</h2>
        <p>
          Timelines given at checkout are estimates, not guarantees. Where a delay is our fault we
          will refund any delivery charge paid. See <Link href="/shipping">Shipping</Link> for the
          detail.
        </p>
      </section>

      <section>
        <h2>5. Returns</h2>
        <p>
          You may return most items within {config.returnWindowDays} days of delivery under the
          conditions set out in our <Link href="/returns">returns policy</Link>, which forms part of
          these terms. Nothing in these terms limits your rights under the Consumer Protection
          Act, 2019.
        </p>
      </section>

      <section>
        <h2>6. Product descriptions</h2>
        <p>
          We describe products as accurately as we can, and measure garments ourselves rather than
          repeating supplier claims. Colours vary between screens, and items finished by hand vary
          a little piece to piece — where that is expected, the product page says so.
        </p>
      </section>

      <section>
        <h2>7. Your account</h2>
        <p>
          You are responsible for keeping your account credentials to yourself and for activity
          under your account. Tell us promptly if you think someone else has access.
        </p>
      </section>

      <section>
        <h2>8. Acceptable use</h2>
        <p>
          Please do not attempt to disrupt the site, scrape it at scale, or use it to resell our
          products as your own. We reserve the right to close accounts that do.
        </p>
      </section>

      <section>
        <h2>9. Intellectual property</h2>
        <p>
          The Daily Choice Zone name, logo, photography and site content belong to us. You are
          welcome to share links and product images for personal, non-commercial purposes.
        </p>
      </section>

      <section>
        <h2>10. Liability</h2>
        <p>
          Our liability for any order is limited to the value of that order. We are not liable for
          indirect or consequential losses. Nothing here excludes liability that cannot lawfully be
          excluded, including for death, personal injury or fraud.
        </p>
      </section>

      <section>
        <h2>11. Governing law</h2>
        <p>
          These terms are governed by the laws of India, and the courts of Bengaluru, Karnataka
          have exclusive jurisdiction over any dispute.
        </p>
      </section>

      <section>
        <h2>12. Changes</h2>
        <p>
          We may update these terms. The version that applies to your order is the one published
          when you placed it, and the date at the top of this page shows when it last changed.
        </p>
      </section>
    </ContentPage>
  );
}
