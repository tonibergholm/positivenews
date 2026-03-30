import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/news",
  // Allow external image domains from feed sources
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
};

export default nextConfig;
