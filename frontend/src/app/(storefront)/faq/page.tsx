import type { Metadata } from "next";

import { ContentPage } from "@/components/layout/ContentPage";
import { Accordion } from "@/components/ui/Accordion";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "FAQ & size guide",
  description:
    "Answers on delivery, returns, payment and sizing at Daily Choice Zone, plus full size charts for clothing and footwear.",
  alternates: { canonical: "/faq" },
};

export default async function FaqPage() {
  const config = await getSiteConfig();

  const faqs = [
    {
      question: "How long does delivery take?",
      answer: `Standard delivery is 3–5 business days and free on orders above ₹${config.freeDeliveryThreshold.toLocaleString("en-IN")}. Below that it is ₹${config.standardDeliveryFee}. Express delivery arrives in 1–2 business days for ₹149. Everything is dispatched within 24 hours of the order being placed.`,
    },
    {
      question: "Can I return something?",
      answer: `Yes — within ${config.returnWindowDays} days of delivery, as long as the item is unworn with its tags attached. We arrange the pickup, so you do not need to post anything. Refunds reach the original payment method within 5–7 business days of the item reaching us.`,
    },
    {
      question: "What if the size is wrong?",
      answer:
        "Exchanges work the same way as returns: request one from your order, we collect the original and send the new size. If the size you need is out of stock we refund instead. The size charts below are measured from the garments themselves, not a generic standard.",
    },
    {
      question: "How do I track my order?",
      answer:
        "Every order has its own page under Orders in your account, showing its current stage and the expected delivery date. We also email updates at dispatch and on the day of delivery.",
    },
    {
      question: "Which payment methods do you accept?",
      answer:
        "UPI, credit and debit cards (Visa, Mastercard, RuPay and Amex), net banking from all major Indian banks, and cash on delivery. Note that this demo storefront has no payment gateway connected, so no payment is actually taken.",
    },
    {
      question: "Are the products genuine?",
      answer:
        "Everything is sourced directly by us or made under our own house brands — Daily Choice, Zone Essentials, Loom & Co., Terra Living, Nyra, Kaya Beauty, Meridian, Stride and Atelier Nine. There is no third-party marketplace, so there is no grey stock.",
    },
    {
      question: "Do you deliver everywhere in India?",
      answer:
        "We deliver to most PIN codes across India. A handful of remote areas are served by a slower partner courier, which adds two or three days; you will see the accurate estimate at checkout.",
    },
    {
      question: "Something arrived damaged. What now?",
      answer: `Email ${config.support.email} with your order number and a photograph within 48 hours of delivery. We will send a replacement or refund immediately — you will not need to return the damaged item first.`,
    },
  ];

  return (
    <ContentPage
      title="FAQ & size guide"
      intro="The questions we get asked most, and the measurements behind our sizes."
    >
      <section>
        <h2>Frequently asked questions</h2>
        <div className="mt-4 border-t border-ink-200">
          {faqs.map((faq) => (
            <Accordion key={faq.question} title={faq.question}>
              <p className="text-sm leading-relaxed text-ink-700">{faq.answer}</p>
            </Accordion>
          ))}
        </div>
      </section>

      <section id="size-guide" className="scroll-mt-28">
        <h2>Size guide</h2>
        <p>
          All measurements are in inches and taken from the garment laid flat, then doubled where
          relevant. If you are between sizes on a fitted style, size up; on anything described as
          oversized, take your usual size.
        </p>

        <h3>Women&rsquo;s clothing</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Size</th>
              <th scope="col">Bust</th>
              <th scope="col">Waist</th>
              <th scope="col">Hip</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["XS", "32", "25", "35"],
              ["S", "34", "27", "37"],
              ["M", "36", "29", "39"],
              ["L", "38.5", "31.5", "41.5"],
              ["XL", "41", "34", "44"],
              ["XXL", "43.5", "36.5", "46.5"],
            ].map(([size, bust, waist, hip]) => (
              <tr key={size}>
                <td>{size}</td>
                <td>{bust}</td>
                <td>{waist}</td>
                <td>{hip}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Men&rsquo;s clothing</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Size</th>
              <th scope="col">Chest</th>
              <th scope="col">Waist</th>
              <th scope="col">Sleeve</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["XS", "35", "29", "32"],
              ["S", "37", "31", "32.5"],
              ["M", "39", "33", "33"],
              ["L", "41.5", "35.5", "33.5"],
              ["XL", "44", "38", "34"],
              ["XXL", "46.5", "40.5", "34.5"],
            ].map(([size, chest, waist, sleeve]) => (
              <tr key={size}>
                <td>{size}</td>
                <td>{chest}</td>
                <td>{waist}</td>
                <td>{sleeve}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Footwear</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">UK</th>
              <th scope="col">EU</th>
              <th scope="col">Foot length (cm)</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["3", "36", "22.5"],
              ["4", "37", "23.5"],
              ["5", "38", "24.1"],
              ["6", "39", "25.0"],
              ["7", "41", "25.7"],
              ["8", "42", "26.5"],
              ["9", "43", "27.3"],
              ["10", "44", "28.0"],
              ["11", "45", "28.8"],
            ].map(([uk, eu, length]) => (
              <tr key={uk}>
                <td>UK {uk}</td>
                <td>{eu}</td>
                <td>{length}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Kids</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Size</th>
              <th scope="col">Height (cm)</th>
              <th scope="col">Chest</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["2-3Y", "92–98", "21"],
              ["4-5Y", "104–110", "22.5"],
              ["6-7Y", "116–122", "24"],
              ["8-9Y", "128–134", "26"],
              ["10-11Y", "140–146", "28"],
            ].map(([size, height, chest]) => (
              <tr key={size}>
                <td>{size}</td>
                <td>{height}</td>
                <td>{chest}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p>
          Still unsure? Email <a href={`mailto:${config.support.email}`}>{config.support.email}</a>{" "}
          with the product name and your usual size, and we will measure the actual garment for
          you.
        </p>
      </section>
    </ContentPage>
  );
}
