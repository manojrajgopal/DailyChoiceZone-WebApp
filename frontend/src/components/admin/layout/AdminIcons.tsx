import {
  BadgePercent,
  Boxes,
  Compass,
  CreditCard,
  FileBarChart,
  FileMinus,
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutTemplate,
  Palette,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Star,
  Tags,
  Undo2,
  Users,
} from "lucide-react";

/**
 * Maps the icon names in the sidebar document to components.
 *
 * The sidebar is data-driven, and an API cannot send a React component — so
 * the document names an icon and this is the one place that resolves it.
 *
 * **These names are the whole vocabulary.** The navigation editor builds its
 * icon dropdown from `ICON_NAMES` below, so nobody can save a name that has no
 * glyph behind it. Adding a new one means one entry here, and it appears in
 * the dropdown for free.
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
  billing: Receipt,
  invoices: FileText,
  payments: CreditCard,
  refunds: Undo2,
  creditNotes: FileMinus,
  site: Palette,
  content: FileText,
  navigation: Compass,
} as const;

export type AdminIconName = keyof typeof ICONS;

/** Every icon the sidebar can draw. The navigation editor offers exactly these. */
export const ICON_NAMES = Object.keys(ICONS) as AdminIconName[];

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
