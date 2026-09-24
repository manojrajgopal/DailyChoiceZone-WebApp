import type { NextConfig } from "next";

/**
 * Built to run on Node.
 *
 * This used to be `output: "export"` — plain HTML written to `out/`, servable
 * by any static host with no process behind it. That worked while every figure
 * on every page was baked into the bundle at build time.
 *
 * It stopped working the moment the data moved to MySQL. A static export can
 * only render what was true when it was built, so an administrator changing a
 * price would have needed a redeploy before anybody saw it, and pages that
 * depend on who is asking — the cart, the account, the portal — would have had
 * nothing to render on the server at all. A Node server renders per request,
 * which is what a storefront backed by a live database needs.
 *
 * Deployment moves with it: a Render Web Service (or any Node host) running
 * `next build && next start`, rather than a Static Site.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  images: {
    /**
     * The optimizer is available again now there is a server, but product
     * photography already comes from Unsplash sized through URL parameters, so
     * it would be re-fetching and re-encoding images that are already the right
     * size. `remotePatterns` still bounds where images may come from.
     */
    unoptimized: true,
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
};

export default nextConfig;
