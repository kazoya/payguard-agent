import { describe, expect, it } from "vitest";
import { applyCheckoutUrls, checkoutUrlsFrom, extractApprovalLink, summarizeCapture, unwrapToolkitData, verifyCheckoutUrl } from "@/paypal/checkout";

const TOKEN = "3FY11740RF298331J";

describe("verifyCheckoutUrl (buyer approval link allowlist)", () => {
  it.each([
    `https://www.sandbox.paypal.com/checkoutnow?token=${TOKEN}`,
    `https://sandbox.paypal.com/checkoutnow?token=${TOKEN}`,
    `https://WWW.SANDBOX.PAYPAL.COM/checkoutnow?token=${TOKEN}`,
  ])("accepts %s", (href) => {
    expect(verifyCheckoutUrl(href)).toMatchObject({ ok: true });
  });

  it.each([
    [`http://www.sandbox.paypal.com/checkoutnow?token=${TOKEN}`, "NOT_HTTPS"],
    [`javascript:alert(1)`, "NOT_HTTPS"],
    [`https://www.paypal.com/checkoutnow?token=${TOKEN}`, "HOST_NOT_ALLOWED"],
    [`https://evil.example/checkoutnow?token=${TOKEN}`, "HOST_NOT_ALLOWED"],
    [`https://sandbox.paypal.com.evil.com/checkoutnow`, "HOST_NOT_ALLOWED"],
    [`https://evil-sandbox.paypal.com/checkoutnow`, "HOST_NOT_ALLOWED"],
    [`https://www.sandbox.paypal.com:8443/checkoutnow`, "HOST_NOT_ALLOWED"],
    [`https://user:pw@www.sandbox.paypal.com/checkoutnow`, "HOST_NOT_ALLOWED"],
    [`not a url`, "INVALID_URL"],
  ])("rejects %s (%s)", (href, reason) => {
    expect(verifyCheckoutUrl(href)).toMatchObject({ ok: false, reason });
  });

  it("never accepts the live checkout host", () => {
    expect(verifyCheckoutUrl("https://www.paypal.com/checkoutnow?token=X")).toMatchObject({ ok: false, host: "www.paypal.com" });
  });
});

describe("extractApprovalLink", () => {
  const self = { rel: "self", href: `https://api.sandbox.paypal.com/v2/checkout/orders/${TOKEN}` };
  it("prefers rel payer-action, then approve", () => {
    const data = { links: [self, { rel: "approve", href: "https://sandbox.paypal.com/a" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/p" }] };
    expect(extractApprovalLink(data)).toEqual({ kind: "accepted", url: "https://www.sandbox.paypal.com/p" });
    expect(extractApprovalLink({ links: [self, { rel: "approve", href: "https://sandbox.paypal.com/a" }] })).toEqual({ kind: "accepted", url: "https://sandbox.paypal.com/a" });
  });
  it("reports a rejected link without returning its URL", () => {
    const r = extractApprovalLink({ links: [{ rel: "payer-action", href: "https://evil.example/pay" }] });
    expect(r).toEqual({ kind: "rejected", rel: "payer-action", reason: "HOST_NOT_ALLOWED", host: "evil.example" });
  });
  it("returns none when there is no approval link", () => {
    expect(extractApprovalLink({ links: [self] })).toEqual({ kind: "none" });
    expect(extractApprovalLink({})).toEqual({ kind: "none" });
    expect(extractApprovalLink(null)).toEqual({ kind: "none" });
  });
});

describe("checkoutUrlsFrom / applyCheckoutUrls (guard-owned redirect targets)", () => {
  it("builds return and cancel URLs from APP_BASE_URL", () => {
    expect(checkoutUrlsFrom("https://payguard.example")).toEqual({ returnUrl: "https://payguard.example/checkout/return", cancelUrl: "https://payguard.example/checkout/cancel" });
    expect(checkoutUrlsFrom("http://localhost:3000/")).toEqual({ returnUrl: "http://localhost:3000/checkout/return", cancelUrl: "http://localhost:3000/checkout/cancel" });
  });
  it("is null when APP_BASE_URL is empty or unusable", () => {
    for (const v of ["", "   ", undefined, null, "not a url", "ftp://x.example"]) expect(checkoutUrlsFrom(v)).toBeNull();
  });
  it("drops model-supplied URLs and sets ours on create_order only", () => {
    const urls = checkoutUrlsFrom("https://payguard.example")!;
    const args = { currencyCode: "USD", items: [], returnUrl: "https://evil.example/r", cancelUrl: "https://evil.example/c" };
    const r = applyCheckoutUrls("create_order", args, urls);
    expect(r.args).toMatchObject({ returnUrl: urls.returnUrl, cancelUrl: urls.cancelUrl });
    expect(r.dropped).toEqual(["returnUrl", "cancelUrl"]);
    expect(args.returnUrl).toBe("https://evil.example/r"); // input not mutated
    const none = applyCheckoutUrls("create_order", args, null);
    expect(none.args).not.toHaveProperty("returnUrl");
    expect(none.args).not.toHaveProperty("cancelUrl");
    expect(applyCheckoutUrls("pay_order", { id: TOKEN, returnUrl: "x" }, urls)).toEqual({ args: { id: TOKEN, returnUrl: "x" }, dropped: [] });
  });
});

describe("capture responses", () => {
  const order = { id: TOKEN, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP123", status: "COMPLETED" }] } }] };
  it("unwraps the toolkit's pay_order envelope", () => {
    expect(unwrapToolkitData("pay_order", { status: "success", response: order })).toEqual({ ok: true, data: order });
    expect(unwrapToolkitData("pay_order", { status: "error", response: { name: "UNPROCESSABLE_ENTITY", message: "ORDER_NOT_APPROVED" } })).toEqual({ ok: false, message: "ORDER_NOT_APPROVED" });
    expect(unwrapToolkitData("pay_order", order)).toEqual({ ok: true, data: order });
    expect(unwrapToolkitData("get_order", { status: "success", response: 1 })).toEqual({ ok: true, data: { status: "success", response: 1 } });
  });
  it("summarizes the first capture", () => {
    expect(summarizeCapture(order)).toEqual({ orderId: TOKEN, orderStatus: "COMPLETED", captureId: "CAP123", captureStatus: "COMPLETED" });
    expect(summarizeCapture({ id: TOKEN, status: "APPROVED" })).toMatchObject({ captureId: null });
    expect(summarizeCapture(null)).toBeNull();
  });
});
