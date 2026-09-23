import {
  BadgePercent,
  Boxes,
  FileBarChart,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutTemplate,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Star,
  Tags,
  Users,
} from "lucide-react";

/**
 * Maps the icon names in `admin/navigation.json` to components.
 *
 * The sidebar is data-driven, and JSON cannot hold a React component — so the
 * config names an icon and this is the one place that resolves it. Adding a nav
 * item means adding a line of JSON plus, if it needs a new glyph, one entry
 * here.
 */
const ICONS = {
  dashboard: LayoutDashboard,
  reports: FileBarChart,
  products: Package,
  categories: Tags,
  collections: Boxes,
  inventory: Boxes,
  orders: ShoppingCart,
  customers: Users,
  coupons: BadgePercent,
  reviews: Star,
  homepage: LayoutTemplate,
  banners: ImageIcon,
  settings: Settings,
  adminUsers: ShieldCheck,
} as const;

export type AdminIconName = keyof typeof ICONS;

export function AdminIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  // An unknown icon falls back rather than crashing the whole sidebar.
  const Icon = ICONS[name as AdminIconName] ?? Package;
  return <Icon className={className} strokeWidth={1.75} aria-hidden="true" />;
}
