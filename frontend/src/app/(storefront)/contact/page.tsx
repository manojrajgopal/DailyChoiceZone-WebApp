import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Clock, Mail, MapPin, Phone } from "lucide-react";

import { ContactCenter } from "@/components/support/ContactCenter";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Skeleton } from "@/components/ui/Skeleton";
import { getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Contact us",
  description:
    "Get help with an order, a payment, a return or anything else — answers, live chat and support requests from the Daily Choice Zone team.",
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
          Tell us what you need and we&rsquo;ll point you to the answer — or to the right person on
          our team, who&rsquo;ll pick it up from there.
        </p>
      </header>

      <div className="mt-8">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <ContactCenter />
        </Suspense>
      </div>

      <section aria-labelledby="other-ways" className="mt-14 border-t border-ink-200 pt-10">
        <h2 id="other-ways" className="label-wide mb-5 text-ink">
          Other ways to reach us
        </h2>

        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
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
                        className="break-words underline decoration-ink-300 underline-offset-2 transition-colors hover:text-copper-700"
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
            Already ordered? Each order in your{" "}
            <Link
              href="/account/orders"
              className="text-copper-700 underline underline-offset-2 hover:text-ink"
            >
              order history
            </Link>{" "}
            has its own status, and your{" "}
            <Link
              href="/account/support"
              className="text-copper-700 underline underline-offset-2 hover:text-ink"
            >
              support requests
            </Link>{" "}
            keep every conversation with us in one place.
          </p>
        </div>
      </section>
    </div>
  );
}
