import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module and the toolkit's large dependency tree stay out of the server bundle.
  serverExternalPackages: ["better-sqlite3", "@paypal/agent-toolkit"],
  // Files read at runtime with fs (policy, migrations, demo seed). Serverless hosts such as Vercel
  // only ship traced files, so list them explicitly for every route.
  outputFileTracingIncludes: {
    "/**": ["./policies/**", "./src/db/migrations/**", "./seed/**"],
  },
};

export default nextConfig;
