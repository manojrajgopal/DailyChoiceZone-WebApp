import Link from "next/link";
import { Facebook, Instagram, Twitter, Youtube } from "lucide-react";

import type { SiteConfig, SocialIcon } from "@/types";

import { Logo } from "@/components/common/Logo";

import { CopyrightYear } from "./CopyrightYear";
import { Newsletter } from "./Newsletter";

const SOCIAL_ICONS: Record<SocialIcon, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  instagram: Instagram,
  facebook: Facebook,
  youtube: Youtube,
  twitter: Twitter,
};

/** The icons a social link can name. The settings screen offers exactly these. */
export const SOCIAL_ICON_NAMES = Object.keys(SOCIAL_ICONS) as SocialIcon[];

/**
 * The site footer.
 *
 * Link columns, support details and delivery thresholds all come from
 * `site-config.json`, so the footer never has to be edited to change a phone
 * number or add a help page.
 */
export function Footer({ config }: { config: SiteConfig }) {
  return (
    <footer className="mt-20 bg-ink text-cream">
      <div className="page-shell py-14 lg:py-16">
        <div className="grid gap-12 lg:grid-cols-[18rem_1fr] lg:gap-16">
          {/* -------------------------------------------------- brand block */}
          <div className="flex flex-col gap-7">
            <div className="inline-flex rounded-pill bg-cream p-3 self-start">
              <Logo variant="mark" size="lg" asLink={false} />
            </div>

            <div>
              <p className="font-display text-lg text-cream">{config.name}</p>
              <p className="mt-1 label-wide text-copper-300">{config.tagline}</p>
            </div>

            <div className="text-sm leading-relaxed text-cream/60">
              <p>
                <a
                  href={`mailto:${config.support.email}`}
                  className="transition-colors hover:text-cream"
                >
                  {config.support.email}
                </a>
              </p>
              <p className="mt-1">
                <a
                  href={`tel:${config.support.phone.replace(/\s/g, "")}`}
                  className="transition-colors hover:text-cream"
                >
                  {config.support.phone}
                </a>
              </p>
              <p className="mt-1 text-cream/40">{config.support.hours}</p>
            </div>

            <ul className="flex gap-2">
              {config.social.map((social) => {
                const Icon = SOCIAL_ICONS[social.icon];
                return (
                  <li key={social.label}>
                    <a
                      href={social.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${config.name} on ${social.label}`}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-pill border border-cream/20 text-cream/70 transition-colors hover:border-cream/60 hover:text-cream"
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.5} />
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* --------------------------------------------- links + newsletter */}
          <div className="flex flex-col gap-12">
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-4">
              {withAddedLinks(config.footer).map((column) => (
                <div key={column.heading}>
                  <h2 className="label-wide mb-4 text-cream/50">{column.heading}</h2>
                  {/* 32px-tall links on touch screens, same spacing as before. */}
                  <ul className="flex flex-col gap-0.5 sm:gap-2.5">
                    {column.links.map((link) => (
                      <li key={`${column.heading}-${link.href}`}>
                        <Link
                          href={link.href}
                          className="inline-flex min-h-8 items-center text-sm text-cream/80 transition-colors hover:text-cream sm:min-h-0"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>

            <Newsletter />
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- legal bar */}
      <div className="border-t border-cream/10">
        <div className="page-shell flex flex-col gap-2 py-5 text-xs text-cream/40 sm:flex-row sm:items-center sm:justify-between">
          <p>
            &copy; <CopyrightYear /> {config.name}. All rights reserved.
          </p>
          <p>
            Free delivery over &#8377;{config.freeDeliveryThreshold.toLocaleString("en-IN")}{" "}
            &middot; {config.returnWindowDays}-day returns
          </p>
        </div>
      </div>
    </footer>
  );
}

/**
 * Pages added after the footer document was first saved: listed in the shop
 * column unless the store already links them (or has no shop column).
 */
const ADDED_LINKS = [{ label: "Gift cards", href: "/gift-cards" }];

function withAddedLinks<T extends { heading: string; links: { label: string; href: string }[] }>(columns: T[]): T[] {
  return columns.map((column) => {
    if (!/shop/i.test(column.heading)) return column;
    const missing = ADDED_LINKS.filter((link) => !columns.some((c) => c.links.some((l) => l.href === link.href)));
    return missing.length ? { ...column, links: [...column.links, ...missing] } : column;
  });
}
