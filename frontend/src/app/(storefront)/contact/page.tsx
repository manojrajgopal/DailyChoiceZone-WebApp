import type { Metadata } from "next";
import Link from "next/link";
import { Clock, Mail, MapPin, Phone } from "lucide-react";

import { ContactForm } from "@/components/layout/ContactForm";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Contact us",
  description:
    "Get in touch with Daily Choice Zone about an order, a return or anything else. Email, phone and a contact form.",
  alternates: { canonical: "/contact" },
};

export default async function ContactPage() {
  const config = await getSiteConfig();

  const details = [
    {
      icon: Mail,
      label: "Email",
      value: config.support.email,
      href: `mailto:${config.support.email}`,
    },
    {
      icon: Phone,
      label: "Phone",
      value: config.support.phone,
      href: `tel:${config.support.phone.replace(/\s/g, "")}`,
    },
    { icon: Clock, label: "Hours", value: config.support.hours },
    {
      icon: MapPin,
      label: "Warehouse",
      value: "Daily Choice Zone Retail Pvt. Ltd., Bengaluru, Karnataka 560038",
    },
  ];

  return (
    <div className="page-shell py-8 sm:py-12">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Contact us" }]} />

      <header className="mt-5 max-w-2xl">
        <h1 className="font-display text-[1.875rem] leading-tight text-ink sm:text-4xl">
          Contact us
        </h1>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-700">
          Something wrong with an order, or a question before you buy? Send a note and we will come
          back within one working day.
        </p>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_20rem] lg:gap-16">
        <ContactForm />

        <aside>
          <h2 className="label-wide mb-4 text-ink">Other ways to reach us</h2>

          <dl className="flex flex-col gap-5">
            {details.map((detail) => {
              const Icon = detail.icon;
              return (
                <div key={detail.label} className="flex gap-3">
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0 text-copper-600"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <dt className="label-wide text-ink-400">{detail.label}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-ink-700">
                      {detail.href ? (
                        <a
                          href={detail.href}
                          className="underline decoration-ink-300 underline-offset-2 transition-colors hover:text-copper-700"
                        >
                          {detail.value}
                        </a>
                      ) : (
                        detail.value
                      )}
                    </dd>
                  </div>
                </div>
              );
            })}
          </dl>

          <div className="mt-8 rounded-card bg-cream-deep p-4">
            <p className="text-xs leading-relaxed text-ink-700">
              Already ordered? The fastest route is your{" "}
              <Link
                href="/account/orders"
                className="text-copper-700 underline underline-offset-2 hover:text-ink"
              >
                order history
              </Link>
              , where each order has its own status and details.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
