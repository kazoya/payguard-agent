import { describe, expect, it } from "vitest";
import { buildPlanCard } from "@/agent/planCard";
import { toModelResult } from "@/agent/orchestrator";
import { openDb } from "@/db/db";
import { checkoutUrlsFrom, type CheckoutUrls } from "@/paypal/checkout";
import { MockPayPal } from "@/paypal/mockPayPal";
import type { ToolCallHandlerFactory } from "@/paypal/types";
import { createPayGuard } from "@/server/container";
import { approver, clerk, defaultPolicy, fakeClock, MIGRATIONS_DIR, refundArgs } from "../helpers/setup";

const URLS = checkoutUrlsFrom("https://payguard.example")!;
const MUG = { currencyCode: "USD", items: [{ name: "Mug", itemCost: 30, itemTotal: 30, quantity: 1 }] };

function harness(opts: { checkoutUrls?: CheckoutUrls | null; factory?: (p: MockPayPal) => ToolCallHandlerFactory } = {}) {
  const db = openDb(":memory:", MIGRATIONS_DIR);
  const paypal = new MockPayPal();
  const pg = createPayGuard({ db, policy: defaultPolicy(), handlerFactory: opts.factory ? opts.factory(paypal) : paypal.factory, clock: fakeClock().clock, checkoutUrls: opts.checkoutUrls === undefined ? URLS : opts.checkoutUrls });
  const handle = (tool: string, args: Record<string, unknown>, actor = clerk) => pg.guard.handle({ actor, conversationId: null, tool, args, provenance: "trusted" });
  const executedDetail = () => JSON.parse(pg.audit.all().filter((a) => a.event === "EXECUTED").at(-1)!.detail_json!) as Record<string, unknown>;
  return { paypal, ...pg, handle, executedDetail };
}

/** A PayPal stand-in whose create_order answer carries the given approval link. */
const linkFactory = (href: string) => (p: MockPayPal): ToolCallHandlerFactory => (o) => {
  const inner = p.factory(o);
  return {
    ...inner,
    handleToolCall: async (call) => {
      const res = await inner.handleToolCall(call);
      if (call.function.name !== "create_order") return res;
      const body = JSON.parse(String(res.content)) as Record<string, unknown>;
      return { ...res, content: JSON.stringify({ ...body, links: [{ rel: "payer-action", href }] }) };
    },
  };
};

describe("checkout flow: create_order -> buyer approves -> pay_order", () => {
  it("sends guard-owned return/cancel URLs and drops the model's", async () => {
    const h = harness();
    const r = await h.handle("create_order", { ...MUG, returnUrl: "https://evil.example/r", cancelUrl: "https://evil.example/c" });
    expect(r.status).toBe("executed");
    expect(h.paypal.calls[0]!.args).toMatchObject({ returnUrl: URLS.returnUrl, cancelUrl: URLS.cancelUrl });
    expect(h.executedDetail()).toMatchObject({ checkoutRedirect: "app", droppedArgs: ["returnUrl", "cancelUrl"], approvalLink: { status: "accepted" } });
  });

  it("leaves return/cancel to the toolkit default when APP_BASE_URL is not usable", async () => {
    const h = harness({ checkoutUrls: null });
    await h.handle("create_order", MUG);
    expect(h.paypal.calls[0]!.args).not.toHaveProperty("returnUrl");
    expect(h.executedDetail()).toMatchObject({ checkoutRedirect: "not_configured" });
  });

  it("returns the verified sandbox approval link to the model and the card, without raw links", async () => {
    const h = harness();
    const r = await h.handle("create_order", MUG);
    if (r.status !== "executed") throw new Error("expected executed");
    const id = (r.data as { id: string }).id;
    expect(r.checkoutUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${id}`);
    const model = toModelResult(r);
    expect(model).toMatchObject({ status: "executed", checkout_url: r.checkoutUrl, data: { id, status: "PAYER_ACTION_REQUIRED" } });
    expect(model.data).not.toHaveProperty("links");
    expect(String(model.next_step)).toContain("pay_order");
    const card = buildPlanCard({ id: "c1", name: "create_order", args: MUG }, null, model, h.store);
    expect(card).toMatchObject({ status: "executed", resultId: id, paypalStatus: "PAYER_ACTION_REQUIRED", checkoutUrl: r.checkoutUrl, captureId: null });
  });

  it.each([
    ["https://evil.example/checkoutnow?token=X", "HOST_NOT_ALLOWED"],
    ["http://www.sandbox.paypal.com/checkoutnow?token=X", "NOT_HTTPS"],
    ["https://www.paypal.com/checkoutnow?token=X", "HOST_NOT_ALLOWED"],
  ])("drops an approval link outside the sandbox allowlist (%s) and audits it", async (href, reason) => {
    const h = harness({ factory: linkFactory(href) });
    const r = await h.handle("create_order", MUG);
    if (r.status !== "executed") throw new Error("expected executed");
    expect(r.checkoutUrl).toBeNull();
    const model = toModelResult(r);
    expect(model).not.toHaveProperty("checkout_url");
    expect(JSON.stringify(model)).not.toContain(href);
    expect(h.executedDetail()).toMatchObject({ approvalLink: { status: "rejected", rel: "payer-action", reason } });
  });

  it("a card never shows a link the tool result did not verify", () => {
    const h = harness();
    const forged = { status: "executed", tool: "create_order", data: { id: "ORDER1", status: "PAYER_ACTION_REQUIRED" }, checkout_url: "https://evil.example/pay" };
    expect(buildPlanCard({ id: "c1", name: "create_order", args: MUG }, null, forged, h.store).checkoutUrl).toBeNull();
  });

  it("get_order on an order awaiting the buyer re-shares the verified link", async () => {
    const h = harness();
    const created = await h.handle("create_order", MUG);
    const id = (created.status === "executed" ? created.data : {}) as { id: string };
    const got = await h.handle("get_order", { id: id.id });
    expect(got).toMatchObject({ status: "executed", checkoutUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id.id}` });
  });

  it("pay_order captures the approved order: capture id and COMPLETED on the card, refund on the tracked capture", async () => {
    const h = harness();
    const created = await h.handle("create_order", MUG);
    const orderId = ((created.status === "executed" ? created.data : {}) as { id: string }).id;
    const paid = await h.handle("pay_order", { id: orderId });
    if (paid.status !== "executed") throw new Error(`expected executed, got ${paid.status}`);
    expect(paid.checkoutUrl).toBeNull();
    const model = toModelResult(paid);
    expect(model).toMatchObject({ status: "executed", data: { id: orderId, status: "COMPLETED" }, capture: { status: "COMPLETED" } });
    const captureId = (model.capture as { id: string }).id;
    expect(captureId).toMatch(/^MOCKCAPTURE/);
    const card = buildPlanCard({ id: "c2", name: "pay_order", args: { id: orderId } }, null, model, h.store);
    expect(card).toMatchObject({ status: "executed", resultId: orderId, captureId, paypalStatus: "COMPLETED", amountMinor: 3000, checkoutUrl: null });
    expect(h.store.getObject(captureId)).toMatchObject({ kind: "capture", amount_minor: 3000 });
    expect(h.store.getObject(orderId)).toMatchObject({ status: "COMPLETED" });
    expect((await h.handle("create_refund", refundArgs(captureId, "10.00"))).status).toBe("executed");
  });

  it("a capture error from the toolkit envelope is a failure, not a success", async () => {
    const factory = (p: MockPayPal): ToolCallHandlerFactory => (o) => {
      const inner = p.factory(o);
      return { ...inner, handleToolCall: async (call) => call.function.name === "pay_order"
        ? { role: "tool", tool_call_id: call.id, content: JSON.stringify({ status: "error", response: { name: "UNPROCESSABLE_ENTITY", message: "ORDER_NOT_APPROVED" } }) }
        : inner.handleToolCall(call) };
    };
    const h = harness({ factory });
    const created = await h.handle("create_order", MUG);
    const orderId = ((created.status === "executed" ? created.data : {}) as { id: string }).id;
    expect(await h.handle("pay_order", { id: orderId })).toMatchObject({ status: "failed", error: { code: "PAYPAL_ERROR" } });
  });

  it("an approved (queued) create_order also gets the verified link and guard-owned URLs", async () => {
    const h = harness();
    const big = { currencyCode: "USD", items: [{ name: "Laptop", itemCost: 900, itemTotal: 900, quantity: 1 }] };
    const p = await h.handle("create_order", { ...big, returnUrl: "https://evil.example/r" });
    if (p.status !== "pending_approval") throw new Error(`expected pending, got ${p.status}`);
    const r = await h.approvals.approve(p.approvalId, approver);
    if (!r.ok || r.value.status !== "EXECUTED") throw new Error("expected executed approval");
    expect(r.value.result.checkoutUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=MOCKORDER/);
    expect(h.paypal.calls[0]!.args).toMatchObject({ returnUrl: URLS.returnUrl, cancelUrl: URLS.cancelUrl });
  });
});
