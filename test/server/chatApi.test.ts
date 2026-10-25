import { describe, expect, it } from "vitest";
import { getChat, postChat } from "@/server/api/chat";
import type { DisplayMessage } from "@/server/chatService";
import ar from "../fixtures/arabic-inputs.json";
import { INJECTION, LARGE, lina, mockRuntime, nour, SMALL } from "./helpers";

type ChatBody = { conversationId: string; messages: DisplayMessage[] };
const lastAgent = (b: ChatBody) => b.messages.filter((m) => m.role === "assistant").at(-1)!;

describe("POST /api/chat (mock runtime)", () => {
  it("executes a small refund and returns an executed plan card", async () => {
    const { rt } = mockRuntime();
    const res = await postChat(rt, lina, { text: SMALL });
    expect(res.status).toBe(200);
    const msg = lastAgent(res.body as ChatBody);
    expect(msg.cards).toHaveLength(1);
    expect(msg.cards[0]).toMatchObject({ tool: "create_refund", status: "executed", amountMinor: 2000, target: "8MC585209K746392H", ruleId: null });
    expect(msg.cards[0]!.plan).toMatch(/^Plan: refund \$20\.00/);
    expect(msg.text).toMatch(/^Done\. Refunded \$20\.00/);
    expect(rt.mockPayPal!.refundedMinor("8MC585209K746392H")).toBe(2000);
  });

  it("queues a large refund as pending approval without calling PayPal", async () => {
    const { rt } = mockRuntime();
    const res = await postChat(rt, lina, { text: LARGE });
    const card = lastAgent(res.body as ChatBody).cards[0]!;
    expect(card).toMatchObject({ status: "pending_approval", ruleId: "refund-large", approvalStatus: "PENDING" });
    expect(card.approvalId).toMatch(/^apr_/);
    expect(rt.mockPayPal!.calls).toHaveLength(0);
    expect(rt.approvals.get(card.approvalId!)?.conversation_id).toBe((res.body as ChatBody).conversationId);
  });

  it("denies an amount that only appears in customer text", async () => {
    const { rt } = mockRuntime();
    const res = await postChat(rt, lina, { text: INJECTION });
    const card = lastAgent(res.body as ChatBody).cards[0]!;
    expect(card).toMatchObject({ status: "denied", ruleId: "UNTRUSTED_SOURCE" });
    expect(rt.mockPayPal!.calls).toHaveLength(0);
  });

  it("replies in Arabic to an Arabic request", async () => {
    const { rt } = mockRuntime();
    const res = await postChat(rt, lina, { text: ar.refund30, lang: "ar" });
    const msg = lastAgent(res.body as ChatBody);
    expect(msg.cards[0]!.status).toBe("executed");
    expect(msg.text).toMatch(/[\u0600-\u06FF]/);
  });

  it("keeps history server-side across turns and returns it on GET", async () => {
    const { rt } = mockRuntime();
    const first = (await postChat(rt, lina, { text: SMALL })).body as ChatBody;
    await postChat(rt, lina, { conversationId: first.conversationId, text: "Explain the policy limits" });
    const got = getChat(rt, lina, null);
    const body = got.body as ChatBody;
    expect(body.conversationId).toBe(first.conversationId);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(body.messages[3]!.text).toMatch(/Daily refund cap \$200\.00/);
  });

  it("rejects invalid bodies and other users' conversations", async () => {
    const { rt } = mockRuntime();
    expect((await postChat(rt, lina, { text: "" })).status).toBe(400);
    expect((await postChat(rt, lina, { text: 42 })).status).toBe(400);
    expect((await postChat(rt, lina, undefined)).status).toBe(400);
    const first = (await postChat(rt, lina, { text: SMALL })).body as ChatBody;
    expect((await postChat(rt, nour, { conversationId: first.conversationId, text: SMALL })).status).toBe(404);
    expect(getChat(rt, nour, first.conversationId).status).toBe(404);
    expect(getChat(rt, nour, null).body).toEqual({ conversationId: null, messages: [] });
  });
});
