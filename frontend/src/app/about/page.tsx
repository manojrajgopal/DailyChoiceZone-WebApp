import type { Metadata } from "next";

import { ContentPage } from "@/components/layout/ContentPage";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "About us",
  description:
    "Daily Choice Zone is an everyday store built on one rule: if it does not hold up after a year, it does not make the cut.",
  alternates: { canonical: "/about" },
};

export default async function AboutPage() {
  const config = await getSiteConfig();

  return (
    <ContentPage
      title="About Daily Choice Zone"
      intro="We are an everyday store for clothing, home, beauty and lifestyle — built on one rule: if it does not hold up after a year, it does not make the cut."
    >
      <section id="story">
        <h2>Our story</h2>
        <p>
          Daily Choice Zone started with a small frustration. Buying ordinary things — a shirt, a
          bedsheet, a face wash — had somehow become a gamble. Photographs looked one way, the
          parcel arrived another, and the thing itself gave up after a handful of washes.
        </p>
        <p>
          So we started buying the way we would want to be sold to. Every piece is handled, worn
          and washed before it reaches the store. Some of what we order never makes it to the
          catalogue at all, and that is the point.
        </p>
        <p>
          Today the store spans eleven departments and a small family of house brands, all held to
          the same standard: honest description, fair price, and a finish that survives ordinary
          life.
        </p>
      </section>

      <section>
        <h2>How we choose things</h2>
        <ul>
          <li>
            <strong>We touch everything.</strong> Nothing is listed from a supplier catalogue
            alone. If we have not handled it, it is not on the site.
          </li>
          <li>
            <strong>We describe it plainly.</strong> If a shirt runs large, the description says
            so. Surprises belong in fiction, not in product copy.
          </li>
          <li>
            <strong>We price it once.</strong> No inflated list price invented to make a discount
            look bigger. When something is reduced, it is genuinely reduced.
          </li>
          <li>
            <strong>We keep what works.</strong> A good product stays in the range for years
            rather than being replaced each season for the sake of novelty.
          </li>
        </ul>
      </section>

      <section>
        <h2>What we promise</h2>
        <p>
          Free delivery on orders above &#8377;
          {config.freeDeliveryThreshold.toLocaleString("en-IN")}, dispatched within 24 hours from
          our Bengaluru warehouse. {config.returnWindowDays} days to change your mind, with the
          pickup arranged by us. And real people on support — {config.support.hours}.
        </p>
        <p>
          If something goes wrong, tell us at{" "}
          <a href={`mailto:${config.support.email}`}>{config.support.email}</a> and we will fix it.
          That is the whole policy.
        </p>
      </section>

      <section id="careers">
        <h2>Careers</h2>
        <p>
          We are a small team in Bengaluru covering buying, operations, photography, support and
          engineering. We hire for judgement over pedigree, and we would rather train someone
          curious than manage someone credentialed.
        </p>
        <p>
          There are no specific openings posted at the moment. If you would work here anyway, send
          a note and something you have made to{" "}
          <a href={`mailto:${config.support.email}`}>{config.support.email}</a>.
        </p>
      </section>
    </ContentPage>
  );
}
