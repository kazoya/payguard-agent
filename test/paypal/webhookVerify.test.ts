import { generateKeyPairSync, sign } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { crc32Decimal, httpCertFetcher, isAllowedCertUrl, MOCK_WEBHOOK_ID, readWebhookHeaders, signedMessage, verifyWebhook, type WebhookHeaders } from "@/paypal/webhookVerify";

// A throwaway key pair generated per test run stands in for PayPal's signing cert. No network.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test";
const WEBHOOK_ID = "1JE4291016473214C";

const raw = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R1", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } } });

function headersFor(body: string, webhookId = WEBHOOK_ID, over: Partial<WebhookHeaders> = {}): WebhookHeaders {
  const h: WebhookHeaders = {
    "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    "paypal-transmission-time": "2026-10-24T09:00:00Z",
    "paypal-transmission-sig": "",
    "paypal-cert-url": CERT_URL,
    "paypal-auth-algo": "SHA256withRSA",
    ...over,
  };
  h["paypal-transmission-sig"] ||= sign("sha256", Buffer.from(signedMessage(h, webhookId, body)), privateKey).toString("base64");
  return h;
}

const fetchCert = async () => PEM;

describe("PayPal webhook verification", () => {
  it("computes CRC32 as an unsigned decimal string (matches zlib)", () => {
    expect(crc32Decimal("123456789")).toBe("3421780262");
    expect(crc32Decimal(raw)).toBe(String(crc32(raw)));
    expect(crc32Decimal("")).toBe("0");
  });

  it("accepts a valid self-verified signature", async () => {
    const r = await verifyWebhook({ raw, headers: headersFor(raw), webhookId: WEBHOOK_ID, fetchCert });
    expect(r).toEqual({ ok: true, value: { method: "self" } });
  });

  it("verifies simulator events signed for webhook id WEBHOOK_ID", async () => {
    const r = await verifyWebhook({ raw, headers: headersFor(raw, MOCK_WEBHOOK_ID), webhookId: MOCK_WEBHOOK_ID, fetchCert });
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered body (CRC mismatch) and a wrong webhook id", async () => {
    const h = headersFor(raw);
    expect(await verifyWebhook({ raw: raw.replace("20.00", "2000.00"), headers: h, webhookId: WEBHOOK_ID, fetchCert })).toEqual({ ok: false, error: "BAD_SIGNATURE" });
    expect((await verifyWebhook({ raw, headers: h, webhookId: "OTHER", fetchCert })).ok).toBe(false);
  });

  it("rejects cert URLs outside paypal.com without fetching them", async () => {
    const spy = vi.fn(fetchCert);
    for (const url of ["https://evil.example.com/cert.pem", "http://api.paypal.com/cert", "https://paypal.com.evil.io/c", "https://api.paypal.com:8443/c"]) {
      const r = await verifyWebhook({ raw, headers: headersFor(raw, WEBHOOK_ID, { "paypal-cert-url": url }), webhookId: WEBHOOK_ID, fetchCert: spy });
      expect(r).toEqual({ ok: false, error: "CERT_HOST_NOT_ALLOWED" });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(isAllowedCertUrl(CERT_URL)).toBe(true);
    expect(isAllowedCertUrl("not a url")).toBe(false);
  });

  it("rejects unsupported algorithms and missing headers", async () => {
    expect(await verifyWebhook({ raw, headers: headersFor(raw, WEBHOOK_ID, { "paypal-auth-algo": "SHA1withRSA" }), webhookId: WEBHOOK_ID, fetchCert })).toEqual({ ok: false, error: "UNSUPPORTED_ALGO" });
    expect(readWebhookHeaders(new Headers({ "paypal-transmission-id": "x" }))).toEqual({ ok: false, error: "MISSING_HEADERS" });
  });

  it("falls back to postback for real events, never for mock events", async () => {
    const h = headersFor(raw, WEBHOOK_ID, { "paypal-transmission-sig": "bm90LWEtc2ln" });
    const postback = vi.fn(async () => true);
    expect(await verifyWebhook({ raw, headers: h, webhookId: WEBHOOK_ID, fetchCert, postback })).toEqual({ ok: true, value: { method: "postback" } });
    expect(postback).toHaveBeenCalledWith(expect.objectContaining({ webhookId: WEBHOOK_ID, event: JSON.parse(raw) }));

    postback.mockClear();
    expect((await verifyWebhook({ raw, headers: h, webhookId: MOCK_WEBHOOK_ID, fetchCert, postback })).ok).toBe(false);
    expect(postback).not.toHaveBeenCalled();

    const failing = async () => { throw new Error("down"); };
    expect(await verifyWebhook({ raw, headers: h, webhookId: WEBHOOK_ID, fetchCert: failing })).toEqual({ ok: false, error: "CERT_FETCH_FAILED" });
  });

  it("the default cert fetcher refuses non-PayPal hosts and caches PEMs", async () => {
    const fake = vi.fn(async () => new Response(PEM));
    const fetcher = httpCertFetcher(fake as unknown as typeof fetch);
    await expect(fetcher("https://evil.example.com/c")).rejects.toThrow(/not allowed/);
    expect(await fetcher(CERT_URL)).toBe(PEM);
    expect(await fetcher(CERT_URL)).toBe(PEM);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
