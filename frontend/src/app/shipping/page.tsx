import type { Metadata } from "next";

import { ContentPage } from "@/components/layout/ContentPage";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Shipping",
  description:
    "Delivery options, charges and timelines for Daily Choice Zone orders across India, including free delivery thresholds.",
  alternates: { canonical: "/shipping" },
};

export default async function ShippingPage() {
  const config = await getSiteConfig();
  const threshold = config.freeDeliveryThreshold.toLocaleString("en-IN");

  return (
    <ContentPage
      title="Shipping"
      intro={`Dispatched within 24 hours from Bengaluru. Free on orders above ₹${threshold}.`}
    >
      <section>
        <h2>Options and charges</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Timeline</th>
              <th scope="col">Charge</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Standard</td>
              <td>3–5 business days</td>
              <td>
                Free above &#8377;{threshold}, otherwise &#8377;{config.standardDeliveryFee}
              </td>
            </tr>
            <tr>
              <td>Express</td>
              <td>1–2 business days</td>
              <td>&#8377;149</td>
            </tr>
          </tbody>
        </table>
        <p>
          Express is a paid upgrade, so its charge applies whatever the order is worth — the free
          delivery threshold covers standard delivery only.
        </p>
      </section>

      <section>
        <h2>Dispatch</h2>
        <p>
          Orders placed before 4pm IST on a business day are picked, checked and handed to the
          courier the same day. Orders after that, or at a weekend, go out on the next business
          day.
        </p>
        <p>
          Every parcel is inspected by hand before it is sealed. If an item fails that check we
          hold the order and contact you rather than shipping something we would not accept
          ourselves.
        </p>
      </section>

      <section>
        <h2>Where we deliver</h2>
        <p>
          We deliver to most PIN codes across India. A small number of remote areas are served by a
          partner courier that adds two to three days; the estimate shown at checkout is the
          accurate one for your PIN code.
        </p>
        <p>We do not ship internationally at the moment.</p>
      </section>

      <section>
        <h2>Tracking</h2>
        <p>
          You will get an email at dispatch and another on the morning of delivery. Each order also
          has its own page under Orders in your account with its current stage.
        </p>
      </section>

      <section>
        <h2>Missed deliveries</h2>
        <p>
          Couriers attempt delivery up to three times. After a third failed attempt the parcel
          returns to us and we refund in full, minus nothing. If you know you will be away, reply
          to the dispatch email and we will ask the courier to hold it.
        </p>
      </section>

      <section>
        <h2>Questions</h2>
        <p>
          Email <a href={`mailto:${config.support.email}`}>{config.support.email}</a> or call{" "}
          {config.support.phone}, {config.support.hours}.
        </p>
      </section>
    </ContentPage>
  );
}
