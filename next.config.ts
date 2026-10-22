import type { NextConfig } from "next";
import { cspWithAncestors } from "./lib/csp";

/**
 * Security headers for every staff page and API route. The chat frame
 * (/embed/*) is left out here: proxy.ts sets its CSP per bot, because which
 * websites may show a bot (frame-ancestors) is a setting, not a constant.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: cspWithAncestors("'self'") },
];

const nextConfig: NextConfig = {
  // File readers run on the server only; keep them out of the bundler.
  serverExternalPackages: [
    "unpdf",
    "exceljs",
    "mammoth",
    "linkedom",
    "@mozilla/readability",
    "pino",
  ],
  experimental: {
    serverActions: {
      // Small files go straight through a server action; big ones go to Blob first.
      bodySizeLimit: "5mb",
    },
  },
  poweredByHeader: false,
  async headers() {
    return [
      // Everything except the chat frame (proxy.ts sets its headers) and the loader script.
      { source: "/((?!embed/|widget\\.js).*)", headers: securityHeaders },
      {
        source: "/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=86400" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
