import type { Metadata } from "next";

/**
 * Admin route metadata.
 *
 * `noindex, nofollow` on the whole tree: an admin portal has no business in
 * search results, and `robots.ts` disallows the path as well. Belt and braces,
 * because the cost of being wrong is a management console in Google's index.
 */
export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Daily Choice Zone Admin" },
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
