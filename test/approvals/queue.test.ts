import { describe, expect, it } from "vitest";
import { approver, clerk, makeHarness, owner, refundArgs } from "../helpers/setup";

const CAP = "CAPTURE_FIXTURE_1";

async function pendingRefund(value = "120.00") {
  const h = makeHarness();
  h.paypal.addCapture(CAP, "500.00");
  const out = await h.guard.handle({ actor: clerk, conversationId: null, tool: "create_refund", args: refundArgs(CAP, value), provenance: "trusted" });
  if (out.status !== "pending_approval") throw new Error(`expected pending, got ${out.status}`);
  return { h, approvalId: out.approvalId };
}

describe("ApprovalQueue", () => {
  it("a pending action is not executed until approved", async () => {
    const { h, approvalId } = await pendingRefund();
    expect(h.paypal.calls).toHaveLength(0);
    expect(h.approvals.get(approvalId)?.status).toBe("PENDING");
    expect(h.approvals.list("PENDING")).toHaveLength(1);
  });

  it("approve executes once with PayPal-Request-Id = approval id", async () => {
    const { h, approvalId } = await pendingRefund();
    const r = await h.approvals.approve(approvalId, approver, "ok, customer is VIP");
    expect(r).toMatchObject({ ok: true, value: { status: "EXECUTED" } });
    expect(h.paypal.calls).toEqual([expect.objectContaining({ tool: "create_refund", requestId: approvalId })]);
    expect(h.paypal.refundedMinor(CAP)).toBe(12000);
    const row = h.approvals.get(approvalId)!;
    expect(row).toMatchObject({ status: "EXECUTED", decided_by: approver.id, decision_note: "ok, customer is VIP" });
    expect(JSON.parse(row.result_json!)).toMatchObject({ status: "COMPLETED" });
  });

  it("double approve (concurrent) executes exactly once", async () => {
    const { h, approvalId } = await pendingRefund();
    const [a, b] = await Promise.all([h.approvals.approve(approvalId, approver), h.approvals.approve(approvalId, owner)]);
    const oks = [a, b].filter((x) => x.ok);
    const errs = [a, b].filter((x) => !x.ok);
    expect(oks).toHaveLength(1);
    expect(errs[0]).toMatchObject({ ok: false, error: { code: "ALREADY_DECIDED" } });
    expect(h.paypal.calls).toHaveLength(1);
    expect(h.paypal.refundedMinor(CAP)).toBe(12000);
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({ n: 1 });
  });

  it("approving again later is refused", async () => {
    const { h, approvalId } = await pendingRefund();
    await h.approvals.approve(approvalId, approver);
    expect(await h.approvals.approve(approvalId, approver)).toMatchObject({ ok: false, error: { code: "ALREADY_DECIDED" } });
    expect(h.paypal.calls).toHaveLength(1);
  });

  it("reject never executes and needs a reason", async () => {
    const { h, approvalId } = await pendingRefund();
    expect(h.approvals.reject(approvalId, approver, "  ")).toMatchObject({ ok: false, error: { code: "REASON_REQUIRED" } });
    expect(h.approvals.reject(approvalId, approver, "Item was not returned")).toMatchObject({ ok: true, value: { status: "REJECTED" } });
    expect(await h.approvals.approve(approvalId, owner)).toMatchObject({ ok: false, error: { code: "ALREADY_DECIDED" } });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("blocks self-approval, even for an owner", async () => {
    const h = makeHarness();
    h.paypal.addCapture(CAP, "500.00");
    const out = await h.guard.handle({ actor: owner, conversationId: null, tool: "create_refund", args: refundArgs(CAP, "75.00"), provenance: "trusted" });
    expect(out.status).toBe("pending_approval");
    if (out.status !== "pending_approval") return;
    expect(await h.approvals.approve(out.approvalId, owner)).toMatchObject({ ok: false, error: { code: "SELF_APPROVAL" } });
    expect(h.approvals.reject(out.approvalId, owner, "changed my mind")).toMatchObject({ ok: false, error: { code: "SELF_APPROVAL" } });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("a clerk cannot approve", async () => {
    const { h, approvalId } = await pendingRefund();
    const otherClerk = { id: "u_clerk2", role: "clerk" as const };
    expect(await h.approvals.approve(approvalId, otherClerk)).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ROLE" } });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("expired approvals cannot be approved", async () => {
    const { h, approvalId } = await pendingRefund();
    h.time.advanceHours(25);
    expect(await h.approvals.approve(approvalId, approver)).toMatchObject({ ok: false, error: { code: "EXPIRED" } });
    expect(h.approvals.get(approvalId)?.status).toBe("EXPIRED");
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("unknown approval id", async () => {
    const h = makeHarness();
    expect(await h.approvals.approve("apr_nope", approver)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("a PayPal failure marks the approval FAILED and is audited", async () => {
    const { h, approvalId } = await pendingRefund();
    h.paypal.failNext = { status: 422, message: "REFUND_AMOUNT_EXCEEDED" };
    expect(await h.approvals.approve(approvalId, approver)).toMatchObject({ ok: true, value: { status: "FAILED", error: { code: "PAYPAL_ERROR", status: 422 } } });
    expect(h.approvals.get(approvalId)?.status).toBe("FAILED");
    expect(h.audit.all().map((r) => r.event)).toContain("FAILED");
  });

  it("audits every transition and keeps the chain valid", async () => {
    const { h, approvalId } = await pendingRefund();
    await h.approvals.approve(approvalId, clerk); // refused: clerk == requester AND wrong role
    await h.approvals.approve(approvalId, approver);
    const events = h.audit.all().map((r) => r.event);
    expect(events).toEqual(["PROPOSED", "QUEUED", "APPROVAL_REFUSED", "APPROVED", "EXECUTED"]);
    expect(h.audit.all().every((r) => r.event !== "EXECUTED" || r.approval_id === approvalId)).toBe(true);
    expect(h.audit.verifyChain()).toEqual({ ok: true, count: 5 });
  });
});
