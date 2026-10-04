import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "playwright-core",
    "@sparticuz/chromium",
  ],

  outputFileTracingIncludes: {
    "/api/jobs/first-party-event-detector": [
      "./node_modules/playwright-core/browsers.json",
    ],
  },
};

export default nextConfig;
