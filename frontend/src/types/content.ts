/** Site chrome, navigation and homepage composition — all config-driven. */

export interface NavChildLink {
  label: string;
  href: string;
}

export interface NavColumn {
  heading: string;
  links: NavChildLink[];
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
  /** Present when the item opens a mega menu on desktop. */
  columns?: NavColumn[];
  /** Optional promotional card pinned to the right of the mega menu. */
  promo?: {
    title: string;
    subtitle: string;
    image: string;
    href: string;
  };
  /** Renders the label in the sale colour. */
  highlight?: boolean;
}

export interface FooterColumn {
  heading: string;
  links: NavChildLink[];
}

export type SocialIcon = "instagram" | "facebook" | "youtube" | "twitter";

export interface SocialLink {
  label: string;
  href: string;
  icon: SocialIcon;
}

export interface PromoBanner {
  id: string;
  message: string;
  href?: string;
}

export type TrustIcon = "truck" | "shield" | "refresh" | "headset";

export interface TrustPoint {
  icon: TrustIcon;
  title: string;
  text: string;
}

export interface SiteConfig {
  name: string;
  tagline: string;
  description: string;
  currency: "INR";
  locale: string;
  url: string;
  support: { email: string; phone: string; hours: string };
  freeDeliveryThreshold: number;
  standardDeliveryFee: number;
  returnWindowDays: number;
  social: SocialLink[];
  footer: FooterColumn[];
  trustPoints: TrustPoint[];
}

/**
 * Homepage sections are data, not JSX.
 *
 * Reordering the homepage, retitling a rail or dropping a section is an edit to
 * `homepage.json`; `app/page.tsx` never changes. `source` names a catalogue
 * query that the section renderer knows how to run.
 */
export type HomeSectionSource =
  | "new"
  | "trending"
  | "bestsellers"
  | "featured"
  | "recommended"
  | "deals";

export type HomeSection =
  | {
      type: "product-rail";
      id: string;
      title: string;
      subtitle?: string;
      source: HomeSectionSource;
      limit: number;
      /** Where "View all" points. Omit to hide the link. */
      viewAllHref?: string;
      /** Rails scroll horizontally on small screens; grids always wrap. */
      layout?: "rail" | "grid";
    }
  | {
      type: "category-grid";
      id: string;
      title: string;
      subtitle?: string;
      limit?: number;
    }
  | {
      type: "collection-grid";
      id: string;
      title: string;
      subtitle?: string;
      limit?: number;
    }
  | {
      type: "editorial-split";
      id: string;
      title: string;
      body: string;
      image: string;
      ctaLabel: string;
      ctaHref: string;
      /** Which side the image sits on at desktop widths. */
      align?: "left" | "right";
    }
  | { type: "trust-strip"; id: string };

export interface HomepageConfig {
  sections: HomeSection[];
}

export interface Review {
  id: string;
  productId: string;
  author: string;
  rating: number;
  title: string;
  body: string;
  date: string;
  verified: boolean;
}

/** Aggregate review stats for a product, computed by reviewService. */
export interface ReviewSummary {
  average: number;
  total: number;
  /** Count per star level, indexed 5 down to 1. */
  distribution: { stars: number; count: number }[];
}
