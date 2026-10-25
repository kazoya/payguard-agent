import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";

/**
 * PayPal webhook verification (https://developer.paypal.com/api/rest/webhooks/rest).
 * Primary: self-verification. The signed message is `transmissionId|timeStamp|webhookId|crc32(rawBody)`,
 * checked with SHA256 against the certificate at `paypal-cert-url` (host allow-listed to *.paypal.com).
 * Fallback: an injected postback to /v1/notifications/verify-webhook-signature (never for mock events,
 * whose webhook id is the literal "WEBHOOK_ID"; PayPal does not support postback for them).
 */

export const MOCK_WEBHOOK_ID = "WEBHOOK_ID";

const HeaderSchema = z.object({
  "paypal-transmission-id": z.string().min(1).max(200),
  "paypal-transmission-time": z.string().min(1).max(100),
  "paypal-transmission-sig": z.string().min(1).max(4096),
  "paypal-cert-url": z.string().min(1).max(2048),
  "paypal-auth-algo": z.string().min(1).max(100),
});

export type WebhookHeaders = z.infer<typeof HeaderSchema>;
export type HeaderSource = { get(name: string): string | null };

export type CertFetcher = (url: string) => Promise<string>;
export type Postback = (input: { headers: WebhookHeaders; webhookId: string; event: unknown }) => Promise<boolean>;

export type VerifyFailure =
  | "MISSING_HEADERS"
  | "CERT_HOST_NOT_ALLOWED"
  | "UNSUPPORTED_ALGO"
  | "CERT_FETCH_FAILED"
  | "BAD_SIGNATURE";

export type VerifyOk = { method: "self" | "postback" };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 (IEEE) of the raw body as an unsigned decimal string, as PayPal signs it. */
export function crc32Decimal(raw: Buffer | string): string {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return String((c ^ 0xffffffff) >>> 0);
}

export function readWebhookHeaders(h: HeaderSource): Result<WebhookHeaders, VerifyFailure> {
  const parsed = HeaderSchema.safeParse(Object.fromEntries(Object.keys(HeaderSchema.shape).map((k) => [k, h.get(k) ?? undefined])));
  return parsed.success ? ok(parsed.data) : err("MISSING_HEADERS");
}

/** Only https URLs on paypal.com (or a subdomain) may be fetched for the signing cert. */
export function isAllowedCertUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com")) && u.port === "";
  } catch {
    return false;
  }
}

export function signedMessage(h: WebhookHeaders, webhookId: string, raw: Buffer | string): string {
  return `${h["paypal-transmission-id"]}|${h["paypal-transmission-time"]}|${webhookId}|${crc32Decimal(raw)}`;
}

function selfVerify(h: WebhookHeaders, webhookId: string, raw: Buffer | string, pem: string): boolean {
  try {
    const key = createPublicKey(pem); // accepts an X.509 certificate or a public key PEM
    return cryptoVerify("sha256", Buffer.from(signedMessage(h, webhookId, raw), "utf8"), key, Buffer.from(h["paypal-transmission-sig"], "base64"));
  } catch {
    return false;
  }
}

export async function verifyWebhook(input: {
  raw: Buffer | string;
  headers: WebhookHeaders;
  webhookId: string;
  fetchCert: CertFetcher;
  postback?: Postback;
}): Promise<Result<VerifyOk, VerifyFailure>> {
  const { raw, headers, webhookId, fetchCert, postback } = input;
  if (!isAllowedCertUrl(headers["paypal-cert-url"])) return err("CERT_HOST_NOT_ALLOWED");
  if (!/^SHA256withRSA$/i.test(headers["paypal-auth-algo"])) return err("UNSUPPORTED_ALGO");

  let pem: string | null = null;
  try {
    pem = await fetchCert(headers["paypal-cert-url"]);
  } catch {
    pem = null;
  }
  if (pem && selfVerify(headers, webhookId, raw, pem)) return ok({ method: "self" });

  if (postback && webhookId !== MOCK_WEBHOOK_ID) {
    let event: unknown;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return err("BAD_SIGNATURE");
    }
    if (await postback({ headers, webhookId, event }).catch(() => false)) return ok({ method: "postback" });
  }
  return err(pem ? "BAD_SIGNATURE" : "CERT_FETCH_FAILED");
}

/** Default cert fetcher: allow-listed host only, small cache, no redirects. */
export function httpCertFetcher(fetchImpl: typeof fetch = fetch): CertFetcher {
  const cache = new Map<string, string>();
  return async (url) => {
    if (!isAllowedCertUrl(url)) throw new Error("cert host not allowed");
    const hit = cache.get(url);
    if (hit) return hit;
    const res = await fetchImpl(url, { redirect: "error" });
    if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
    const pem = await res.text();
    if (cache.size > 20) cache.clear();
    cache.set(url, pem);
    return pem;
  };
}
