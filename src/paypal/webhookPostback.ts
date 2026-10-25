import { SANDBOX_API_BASE } from "./toolkit";
import type { Postback } from "./webhookVerify";

/**
 * Fallback verification through PayPal's verify-webhook-signature API (sandbox only).
 * Credentials come from the validated env at runtime; nothing is logged.
 */
export function sandboxPostback(creds: { clientId: string; clientSecret: string }, fetchImpl: typeof fetch = fetch): Postback {
  return async ({ headers, webhookId, event }) => {
    const tokenRes = await fetchImpl(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenRes.ok) return false;
    const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
    if (!token) return false;
    const res = await fetchImpl(`${SANDBOX_API_BASE}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { verification_status?: string };
    return body.verification_status === "SUCCESS";
  };
}
