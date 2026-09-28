import type { Metadata } from "next";

import { ContentPage } from "@/components/layout/ContentPage";
import { Accordion } from "@/components/ui/Accordion";
import { getSiteConfig, getSiteContent } from "@/services/siteService";

export const metadata: Metadata = {
  title: "FAQ & size guide",
  description:
    "Answers on delivery, returns, payment and sizing at Daily Choice Zone, plus full size charts for clothing and footwear.",
  alternates: { canonical: "/faq" },
};

/**
 * The FAQ and the size charts.
 *
 * Both are read from the store rather than written into this page: they are
 * the two things somebody in customer support most wants to correct after
 * answering the same question twice, and neither should need a deployment.
 */
export default async function FaqPage() {
  const [config, content] = await Promise.all([getSiteConfig(), getSiteContent()]);

  return (
    <ContentPage
      title="FAQ & size guide"
      intro="The questions we get asked most, and the measurements behind our sizes."
    >
      <section>
        <h2>Frequently asked questions</h2>
        <div className="mt-4 border-t border-ink-200">
          {content.faqs.map((faq) => (
            <Accordion key={faq.question} title={faq.question}>
              <p className="text-sm leading-relaxed text-ink-700">{faq.answer}</p>
            </Accordion>
          ))}
        </div>
      </section>

      <section id="size-guide" className="scroll-mt-28">
        <h2>Size guide</h2>
        <p>{content.sizeGuide.intro}</p>

        {content.sizeGuide.charts.map((chart) => (
          <div key={chart.title}>
            <h3>{chart.title}</h3>
            <table>
              <thead>
                <tr>
                  {chart.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chart.rows.map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell, index) => (
                      <td key={`${row[0]}-${index}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <p>
          Still unsure? Email <a href={`mailto:${config.support.email}`}>{config.support.email}</a>{" "}
          with the product name and your usual size, and we will measure the actual garment for
          you.
        </p>
      </section>
    </ContentPage>
  );
}
