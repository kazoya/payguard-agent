import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module and the toolkit's large dependency tree stay out of the server bundle.
  serverExternalPackages: ["better-sqlite3", "@paypal/agent-toolkit"],
};

export default nextConfig;
