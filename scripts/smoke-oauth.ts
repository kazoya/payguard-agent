/**
 * Sandbox OAuth smoke test. Run: npm run smoke:oauth (reads .env).
 * Prints only non-secret fields. The access token is never printed or stored.
 */
import { loadEnv, requirePayPalCredentials } from "@/config/env";
import { SANDBOX_API_BASE } from "@/paypal/toolkit";

async function main(): Promise<void> {
  const env = loadEnv(process.env); // throws unless PAYPAL_ENV=sandbox
  const { clientId, clientSecret } = requirePayPalCredentials(env);
  const res = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    console.error(`token request failed: status=${res.status} debug_id=${res.headers.get("paypal-debug-id") ?? "n/a"}`);
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as { expires_in?: number; app_id?: string };
  console.log(`token ok, expires_in=${body.expires_in ?? "?"}, app_id=${body.app_id ?? "?"}`);
}

main().catch((e: unknown) => {
  console.error(`smoke-oauth error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exitCode = 1;
});
