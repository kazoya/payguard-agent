/**
 * Ask the PayPal sandbox to send a simulated event to the configured webhook.
 * Run: npm run webhook:simulate -- PAYMENT.CAPTURE.COMPLETED   (needs PAYPAL_WEBHOOK_ID)
 */
import { loadEnv, requirePayPalCredentials } from "@/config/env";
import { SANDBOX_API_BASE } from "@/paypal/toolkit";

async function main(): Promise<void> {
  const eventType = process.argv[2] ?? "PAYMENT.CAPTURE.COMPLETED";
  const env = loadEnv(process.env);
  const { clientId, clientSecret } = requirePayPalCredentials(env);
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is empty");
  const t = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!t.ok) throw new Error(`token request failed: status=${t.status}`);
  const at = ((await t.json()) as { access_token: string }).access_token;
  const res = await fetch(`${SANDBOX_API_BASE}/v1/notifications/simulate-event`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify({ webhook_id: webhookId, event_type: eventType, resource_version: "2.0" }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
  if (!res.ok) {
    console.error(`simulate failed: status=${res.status} ${body.name ?? ""} ${body.message ?? ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`simulated ${eventType}: event_id=${body.id}`);
}

main().catch((e: unknown) => {
  console.error(`webhook-simulate error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exitCode = 1;
});
