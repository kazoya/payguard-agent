import { sandboxPostback } from "@/paypal/webhookPostback";
import { httpCertFetcher } from "@/paypal/webhookVerify";
import { apiError } from "@/server/api/http";
import { handle } from "@/server/api/route";
import { MAX_WEBHOOK_BYTES, receiveWebhook } from "@/server/api/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const fetchCert = httpCertFetcher();

export async function POST(req: Request): Promise<Response> {
  return handle(req, async (rt) => {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return apiError(413, "TOO_LARGE", "Webhook body too large.");
    const raw = await req.text(); // raw body is required for the CRC32 in the signed message
    const env = rt.env;
    const postback = env?.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? sandboxPostback({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET })
      : undefined;
    return receiveWebhook(rt, raw, req.headers, { fetchCert, postback });
  });
}
