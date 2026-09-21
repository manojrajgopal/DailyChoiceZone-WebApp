import type { NextConfig } from "next";

/**
 * Built as a fully static site.
 *
 * `output: "export"` writes plain HTML, CSS and JS to `out/`, which any static
 * host can serve with no Node process — that is what lets this deploy as a
 * Render Static Site (free, no cold starts) rather than a Web Service.
 *
 * The trade-offs this choice imposes, all of which the code now accounts for:
 *
 * - **No server**, so nothing can read `searchParams` or route params during
 *   rendering. `/search` and `/account/order` read them in the browser
 *   instead, and every catalogue route is enumerated by
 *   `generateStaticParams`.
 * - **No image optimizer.** `unoptimized` makes `next/image` emit the source
 *   URL directly. Product photography already comes from Unsplash sized via
 *   URL parameters, so little is lost; swap this off if you ever move to a
 *   Node deployment.
 * - **Nothing is computed per request.** Anything date-dependent has to run in
 *   the browser, or it would be frozen at build time.
 */
const nextConfig: NextConfig = {
  output: "export",

  /**
   * Emit `shop/index.html` rather than `shop.html`.
   *
   * Static hosts resolve a directory to its `index.html` natively, so this is
   * what makes deep links like `/shop` work without host-specific rewrite
   * rules. Internal links all gain a trailing slash to match.
   */
  trailingSlash: true,

  reactStrictMode: true,

  images: {
    // Required by `output: "export"` — there is no server to optimize through.
    unoptimized: true,
    // Kept for documentation, and enforced again if this ever runs on Node.
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
};

export default nextConfig;
