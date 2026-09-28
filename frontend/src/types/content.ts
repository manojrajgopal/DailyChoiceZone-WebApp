import type { DeliveryMethod, PaymentMethod } from "./order";

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

/**
 * Whether a homepage section is live, and where it sits.
 *
 * Kept separate from `HomeSection` because it is editorial state an
 * administrator changes, not part of what the section *is*. Joined to the
 * sections by id.
 */
export interface HomeSectionLayout {
  id: string;
  active: boolean;
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

/* ------------------------------------------------------------- site content */

/**
 * The lists and copy the storefront and the portal render.
 *
 * Everything here used to be an array in a component or a service — the
 * states a delivery address can name, the topics the contact form offers, the
 * delivery and payment methods, the FAQ, the size charts, and the vocabularies
 * behind the portal's dropdowns. It is one document because it is read once
 * per page load and a dozen small endpoints would be a dozen round trips.
 *
 * `GET /api/site/content`.
 */

export interface Labelled {
  value: string;
  label: string;
}

export interface SizeChart {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface AccountNavItem {
  href: string;
  label: string;
  /** Names an icon the shell maps to a component; the API does not ship React. */
  icon: string;
}

export interface SiteContent {
  states: string[];
  contactTopics: Labelled[];
  popularSearches: string[];
  sortOptions: Labelled[];
  ratingFilters: number[];
  discountFilters: number[];
  deliveryMethods: DeliveryMethod[];
  paymentMethods: PaymentMethodOption[];
  /** Which of them the store currently offers at checkout. */
  enabledPaymentMethods: string[];
  faqs: FaqEntry[];
  sizeGuide: { intro: string; charts: SizeChart[] };
  accountNavigation: AccountNavItem[];
  adminRoles: (Labelled & { description: string })[];
  stockAdjustmentReasons: Labelled[];
  analyticsRanges: (Labelled & { shortLabel: string })[];
  homeSectionKinds: (Labelled & { needsSource: boolean })[];
  homeSectionSources: Labelled[];
}

export interface PaymentMethodOption extends PaymentMethod {
  /** The short form used in tables and on invoices. */
  label: string;
}
