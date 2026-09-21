import type { NextConfig } from "next";

/**
 * Remote image hosts.
 *
 * Dummy product photography is served from Unsplash today. When real product
 * images move to a CDN, add that host here and update `data/products.json` —
 * no component changes are required.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
