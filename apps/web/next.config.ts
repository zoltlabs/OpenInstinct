import type { NextConfig } from "next";

const config: NextConfig = {
  // Vercel packages functions through its adapter; standalone remains for containers.
  output: process.env.VERCEL ? undefined : "standalone",
  serverExternalPackages: ["postgres"],
  transpilePackages: [
    "@openinstinct/connectors",
    "@openinstinct/core",
    "@openinstinct/db",
    "@openinstinct/messaging",
    "@openinstinct/runtime",
    "@openinstinct/worker",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          ...(process.env.NODE_ENV === "production"
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains",
                },
              ]
            : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default config;
