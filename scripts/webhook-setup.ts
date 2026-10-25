/**
 * Sandbox webhook setup. Run: npm run webhook:setup -- https://<public-host>
 * Creates (or reuses) a webhook pointing at <public-host>/api/webhooks/paypal
 * for the events PayGuard handles, and prints only its id. No secrets are printed.
 */
import { loadEnv, requirePayPalCredentials } from "@/config/env";
import { SANDBOX_API_BASE } from "@/paypal/toolkit";

const EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
];

async function token(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token request failed: status=${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function main(): Promise<void> {
  const base = process.argv[2];
  if (!base || !/^https:\/\/[^/]+$/.test(base.replace(/\/$/, ""))) {
    console.error("usage: npm run webhook:setup -- https://<public-host>");
    process.exitCode = 1;
    return;
  }
  const url = `${base.replace(/\/$/, "")}/api/webhooks/paypal`;
  const env = loadEnv(process.env); // throws unless PAYPAL_ENV=sandbox
  const { clientId, clientSecret } = requirePayPalCredentials(env);
  const at = await token(clientId, clientSecret);
  const headers = { Authorization: `Bearer ${at}`, "Content-Type": "application/json" };

  const list = await fetch(`${SANDBOX_API_BASE}/v1/notifications/webhooks`, { headers });
  if (list.ok) {
    const body = (await list.json()) as { webhooks?: { id: string; url: string }[] };
    const hit = body.webhooks?.find((w) => w.url === url);
    if (hit) {
      console.log(`webhook exists: id=${hit.id} url=${url}`);
      return;
    }
  }
  const res = await fetch(`${SANDBOX_API_BASE}/v1/notifications/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, event_types: EVENTS.map((name) => ({ name })) }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
    console.error(`create failed: status=${res.status} ${err.name ?? ""} ${err.message ?? ""} debug_id=${res.headers.get("paypal-debug-id") ?? "n/a"}`);
    process.exitCode = 1;
    return;
  }
  const wh = (await res.json()) as { id: string };
  console.log(`webhook created: id=${wh.id} url=${url}`);
}

main().catch((e: unknown) => {
  console.error(`webhook-setup error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exitCode = 1;
});
