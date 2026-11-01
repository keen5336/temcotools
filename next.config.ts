import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  async headers() {
    return [{ source: "/account/authorize/:path*", headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ] }];
  },
};

export default nextConfig;
