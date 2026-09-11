import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin/",
          "/account/",
          "/auth/",
          "/api/",
          "/login",
          "/forgot-password",
          "/notifications/",
          "/partners/login",
        ],
      },
    ],
    sitemap: "https://tenderfans.com/sitemap.xml",
    host: "https://tenderfans.com",
  };
}
