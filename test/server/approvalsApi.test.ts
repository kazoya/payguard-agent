import { describe, expect, it } from "vitest";
import { approveApproval, listApprovals, rejectApproval, type ApprovalView } from "@/server/api/approvals";
import { getChat, postChat } from "@/server/api/chat";
import type { DisplayMessage } from "@/server/chatService";
import { LARGE, lina, mockRuntime, nour, omar } from "./helpers";

type ChatBody = { conversationId: string; messages: DisplayMessage[] };

async function pending(requester = lina) {
  const ctx = mockRuntime();
  const chat = (await postChat(ctx.rt, requester, { text: LARGE })).body as ChatBody;
  const id = chat.messages.at(-1)!.cards[0]!.approvalId!;
  return { ...ctx, id, conversationId: chat.conversationId };
}

const errCode = (b: unknown) => (b as { error: { code: string } }).error.code;

describe("approvals API", () => {
  it("lists pending approvals with parsed args and requester name", async () => {
    const { rt, id } = await pending();
    const res = listApprovals(rt, "PENDING");
    const list = (res.body as { approvals: ApprovalView[] }).approvals;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, requested_by_name: "Lina", amount_minor: 12000 });
    expect(list[0]!.args).toMatchObject({ capture_id: "2GG279541U471931P" });
    expect(listApprovals(rt, "NOPE").status).toBe(400);
  });

  it("forbids a clerk from approving (403 FORBIDDEN_ROLE)", async () => {
    const { rt, id } = await pending();
    const res = await approveApproval(rt, lina, id, {});
    expect(res.status).toBe(403);
    expect(errCode(res.body)).toBe("FORBIDDEN_ROLE");
  });

  it("forbids self-approval even for an approver (403 SELF_APPROVAL)", async () => {
    const { rt, id } = await pending(omar);
    const res = await approveApproval(rt, omar, id, {});
    expect(res.status).toBe(403);
    expect(errCode(res.body)).toBe("SELF_APPROVAL");
  });

  it("executes on approval and posts a notice back into the requester's chat", async () => {
    const { rt, id } = await pending();
    const res = await approveApproval(rt, omar, id, { note: "ok, regular customer" });
    expect(res.status).toBe(200);
    expect((res.body as { approval: ApprovalView }).approval).toMatchObject({ status: "EXECUTED", decided_by_name: "Omar" });
    expect(rt.mockPayPal!.refundedMinor("2GG279541U471931P")).toBe(12000);

    const again = await approveApproval(rt, nour, id, {});
    expect(again.status).toBe(409);

    const msgs = (getChat(rt, lina, null).body as ChatBody).messages;
    const notice = msgs.at(-1)!;
    expect(notice.role).toBe("notice");
    expect(notice.notice).toMatchObject({ approvalId: id, status: "EXECUTED", decidedBy: "Omar" });
    expect(msgs.find((m) => m.cards.length)!.cards[0]!.approvalStatus).toBe("EXECUTED");
  });

  it("requires a reason to reject (400), then rejects without calling PayPal", async () => {
    const { rt, id } = await pending();
    const bad = rejectApproval(rt, omar, id, { reason: "" });
    expect(bad.status).toBe(400);
    expect(rejectApproval(rt, omar, id, {}).status).toBe(400);
    const ok = rejectApproval(rt, omar, id, { reason: "Customer already got store credit" });
    expect(ok.status).toBe(200);
    expect((ok.body as { approval: ApprovalView }).approval.status).toBe("REJECTED");
    expect(rt.mockPayPal!.calls).toHaveLength(0);
    expect((getChat(rt, lina, null).body as ChatBody).messages.at(-1)!.notice).toMatchObject({ status: "REJECTED", note: "Customer already got store credit" });
  });

  it("returns 404 for unknown ids and 409 for expired approvals", async () => {
    const { rt, id, time } = await pending();
    expect((await approveApproval(rt, omar, "apr_missing", {})).status).toBe(404);
    time.advanceHours(25);
    const res = await approveApproval(rt, omar, id, {});
    expect(res.status).toBe(409);
    expect(errCode(res.body)).toBe("EXPIRED");
  });

  it("expires stale rows when listing and audits the expiry", async () => {
    const { rt, id, time } = await pending();
    time.advanceHours(25);
    expect((listApprovals(rt, "PENDING").body as { approvals: unknown[] }).approvals).toHaveLength(0);
    expect(rt.approvals.get(id)!.status).toBe("EXPIRED");
    expect(rt.audit.all().some((r) => r.event === "EXPIRED" && r.approval_id === id && r.actor === "system")).toBe(true);
    expect(rt.audit.verifyChain().ok).toBe(true);
  });
});
