import type { Metadata } from "next";
import Link from "next/link";

import { ContentPage } from "@/components/layout/ContentPage";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Returns & exchanges",
  description:
    "How to return or exchange a Daily Choice Zone order: the window, the conditions, how pickup works and when refunds land.",
  alternates: { canonical: "/returns" },
};

export default async function ReturnsPage() {
  const config = await getSiteConfig();

  return (
    <ContentPage
      title="Returns & exchanges"
      intro={`${config.returnWindowDays} days to change your mind. We arrange the pickup, so you never have to visit a courier office.`}
    >
      <section>
        <h2>How it works</h2>
        <ul>
          <li>
            Open the order under <Link href="/account/orders">Orders</Link> and choose the item you want
            to send back.
          </li>
          <li>Pick a return or an exchange, and tell us why in one line — it helps us buy better.</li>
          <li>
            We book a pickup for the next business day. Keep the item with its tags and, if you
            still have it, the original packaging.
          </li>
          <li>
            Once it reaches us and passes a quick check, the refund or the replacement goes out.
          </li>
        </ul>
      </section>

      <section>
        <h2>The window</h2>
        <p>
          {config.returnWindowDays} days from the day of delivery. For beauty and personal care the
          item must be unopened and the seal intact, for straightforward hygiene reasons.
        </p>
      </section>

      <section>
        <h2>What we can accept</h2>
        <ul>
          <li>Unworn and unwashed, with all original tags attached.</li>
          <li>Footwear returned in its box, with no scuffing on the soles.</li>
          <li>Beauty and personal care unopened, with the seal unbroken.</li>
          <li>Home textiles unwashed and in their original packaging.</li>
        </ul>
        <p>
          We cannot accept innerwear, pierced jewellery or anything altered or tailored after
          delivery. Items marked as final sale in the product description are also excluded, and
          that is stated on the product page before you buy rather than discovered afterwards.
        </p>
      </section>

      <section>
        <h2>Refunds</h2>
        <p>
          Refunds go to the original payment method within 5–7 business days of the item reaching
          us. For cash on delivery we refund by bank transfer, and ask for the account details
          when the return is raised.
        </p>
        <p>
          Delivery charges are refunded too when the return is our fault — a wrong, damaged or
          misdescribed item. For a simple change of mind the original delivery charge, where one
          was paid, is not refunded.
        </p>
      </section>

      <section>
        <h2>Exchanges</h2>
        <p>
          An exchange is the same process, and we collect the original before dispatching the
          replacement so the size you want is reserved for you. If it sells out in the meantime we
          refund in full instead.
        </p>
      </section>

      <section>
        <h2>Damaged or wrong items</h2>
        <p>
          Email <a href={`mailto:${config.support.email}`}>{config.support.email}</a> with your
          order number and a photograph within 48 hours of delivery. We will send a replacement or
          refund straight away, and you will not have to return the faulty item first.
        </p>
      </section>
    </ContentPage>
  );
}
