import { describe, expect, it } from "vitest";
import type { Llm } from "@/agent/llm";
import { chatAndWait, getChat, getChatTurn, postChat, type TurnBody } from "@/server/api/chat";
import type { DisplayMessage } from "@/server/chatService";
import { failStaleTurns, getTurn } from "@/server/chatTurns";
import ar from "../fixtures/arabic-inputs.json";
import { INJECTION, LARGE, lina, mockRuntime, nour, SMALL } from "./helpers";

type ChatBody = { conversationId: string; messages: DisplayMessage[] };
type Accepted = { conversationId: string; turnId: string; status: string; messages: DisplayMessage[] };
const lastAgent = (b: ChatBody) => b.messages.filter((m) => m.role === "assistant").at(-1)!;

/** An LLM that answers only when the test releases it, to observe a turn while it is pending. */
function gatedLlm(): { llm: Llm; release: () => void; fail: (e: Error) => void } {
  let release!: () => void;
  let fail!: (e: Error) => void;
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  const llm: Llm = { complete: async () => { await gate; return { role: "assistant", content: "All done.", refusal: null } as never; } };
  return { llm, release, fail };
}

describe("chat turns (mock runtime, awaited)", () => {
  it("executes a small refund and returns an executed plan card", async () => {
    const { rt } = mockRuntime();
    const res = await chatAndWait(rt, lina, { text: SMALL });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "done", stoppedAtLimit: false, error: null });
    const msg = lastAgent(res.body as ChatBody);
    expect(msg.cards).toHaveLength(1);
    expect(msg.cards[0]).toMatchObject({ tool: "create_refund", status: "executed", amountMinor: 2000, target: "8MC585209K746392H", ruleId: null });
    expect(msg.cards[0]!.plan).toMatch(/^Plan: refund \$20\.00/);
    expect(msg.text).toMatch(/^Done\. Refunded \$20\.00/);
    expect(rt.mockPayPal!.refundedMinor("8MC585209K746392H")).toBe(2000);
  });

  it("queues a large refund as pending approval without calling PayPal", async () => {
    const { rt } = mockRuntime();
    const res = await chatAndWait(rt, lina, { text: LARGE });
    const card = lastAgent(res.body as ChatBody).cards[0]!;
    expect(card).toMatchObject({ status: "pending_approval", ruleId: "refund-large", approvalStatus: "PENDING" });
    expect(card.approvalId).toMatch(/^apr_/);
    expect(rt.mockPayPal!.calls).toHaveLength(0);
    expect(rt.approvals.get(card.approvalId!)?.conversation_id).toBe((res.body as ChatBody).conversationId);
  });

  it("denies an amount that only appears in customer text", async () => {
    const { rt } = mockRuntime();
    const res = await chatAndWait(rt, lina, { text: INJECTION });
    const card = lastAgent(res.body as ChatBody).cards[0]!;
    expect(card).toMatchObject({ status: "denied", ruleId: "UNTRUSTED_SOURCE" });
    expect(rt.mockPayPal!.calls).toHaveLength(0);
  });

  it("replies in Arabic to an Arabic request", async () => {
    const { rt } = mockRuntime();
    const res = await chatAndWait(rt, lina, { text: ar.refund30, lang: "ar" });
    const msg = lastAgent(res.body as ChatBody);
    expect(msg.cards[0]!.status).toBe("executed");
    expect(msg.text).toMatch(/[\u0600-\u06FF]/);
  });

  it("keeps history server-side across turns and returns it on GET", async () => {
    const { rt } = mockRuntime();
    const first = (await chatAndWait(rt, lina, { text: SMALL })).body as ChatBody;
    await chatAndWait(rt, lina, { conversationId: first.conversationId, text: "Explain the policy limits" });
    const body = getChat(rt, lina, null).body as ChatBody & { activeTurn: unknown };
    expect(body.conversationId).toBe(first.conversationId);
    expect(body.activeTurn).toBeNull();
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(body.messages[3]!.text).toMatch(/Daily refund cap \$200\.00/);
  });

  it("rejects invalid bodies and other users' conversations", async () => {
    const { rt } = mockRuntime();
    expect((await postChat(rt, lina, { text: "" })).status).toBe(400);
    expect((await postChat(rt, lina, { text: 42 })).status).toBe(400);
    expect((await postChat(rt, lina, undefined)).status).toBe(400);
    const first = (await chatAndWait(rt, lina, { text: SMALL })).body as ChatBody;
    expect((await postChat(rt, nour, { conversationId: first.conversationId, text: SMALL })).status).toBe(404);
    expect(getChat(rt, nour, first.conversationId).status).toBe(404);
    expect(getChat(rt, nour, null).body).toEqual({ conversationId: null, messages: [], activeTurn: null });
  });
});

describe("async chat turns: POST 202 + GET /api/chat/turns/:id", () => {
  it("returns 202 at once with the stored user message, then done with the same payload as before", async () => {
    const { rt } = mockRuntime();
    const res = await postChat(rt, lina, { text: SMALL });
    expect(res.status).toBe(202);
    const accepted = res.body as Accepted;
    expect(accepted.turnId).toMatch(/^turn_/);
    expect(accepted.status).toBe("pending");
    expect(accepted.messages.map((m) => [m.role, m.text])).toEqual([["user", SMALL]]);

    await rt.turnTasks.get(accepted.turnId);
    const turn = getChatTurn(rt, lina, accepted.turnId);
    expect(turn.status).toBe(200);
    const body = turn.body as TurnBody;
    expect(body).toMatchObject({ turnId: accepted.turnId, conversationId: accepted.conversationId, status: "done", stoppedAtLimit: false, error: null });
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(lastAgent(body).cards[0]).toMatchObject({ status: "executed", amountMinor: 2000 });
    expect(rt.turnTasks.size).toBe(0);
  });

  it("reports pending while the agent runs, allows one in-flight turn per conversation (409), and resumes via GET /api/chat", async () => {
    const { rt } = mockRuntime();
    const gate = gatedLlm();
    rt.llm = gate.llm;
    const a = (await postChat(rt, lina, { text: "Explain the policy" })).body as Accepted;
    expect((getChatTurn(rt, lina, a.turnId).body as TurnBody).status).toBe("pending");

    const second = await postChat(rt, lina, { conversationId: a.conversationId, text: "And another thing" });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: "TURN_IN_PROGRESS", turnId: a.turnId } });

    // A reloaded page finds the in-flight turn on the conversation and resumes polling it.
    expect(getChat(rt, lina, null).body).toMatchObject({ conversationId: a.conversationId, activeTurn: { turnId: a.turnId } });
    // Another conversation of the same user is not blocked.
    expect((await postChat(rt, lina, { text: "Explain the policy" })).status).toBe(202);

    gate.release();
    await rt.turnTasks.get(a.turnId);
    const done = getChatTurn(rt, lina, a.turnId).body as TurnBody;
    expect(done.status).toBe("done");
    expect(lastAgent(done).text).toBe("All done.");
    expect((await postChat(rt, lina, { conversationId: a.conversationId, text: "Next" })).status).toBe(202);
  });

  it("marks a failed agent turn as error, keeps the user message, and frees the conversation", async () => {
    const { rt } = mockRuntime();
    const gate = gatedLlm();
    rt.llm = gate.llm;
    const a = (await postChat(rt, lina, { text: "Explain the policy" })).body as Accepted;
    gate.fail(new Error("LLM timed out"));
    await rt.turnTasks.get(a.turnId);
    const body = getChatTurn(rt, lina, a.turnId).body as TurnBody;
    expect(body).toMatchObject({ status: "error", error: { code: "AGENT_FAILED" } });
    expect(body.messages.map((m) => m.role)).toEqual(["user"]);
    expect(getChat(rt, lina, a.conversationId).body).toMatchObject({ activeTurn: null });
    expect((await postChat(rt, lina, { conversationId: a.conversationId, text: "retry" })).status).toBe(202);
    expect((await chatAndWait(rt, lina, { text: "x" })).status).toBe(500);
  });

  it("only the owner can read a turn", async () => {
    const { rt } = mockRuntime();
    const a = (await postChat(rt, lina, { text: SMALL })).body as Accepted;
    await rt.turnTasks.get(a.turnId);
    expect(getChatTurn(rt, nour, a.turnId).status).toBe(404);
    expect(getChatTurn(rt, lina, "turn_missing").status).toBe(404);
  });

  it("fails turns left pending by a previous process (restart) and orphaned turns (no task in this process)", async () => {
    const { rt, time } = mockRuntime();
    const gate = gatedLlm();
    rt.llm = gate.llm;
    const a = (await postChat(rt, lina, { text: "one" })).body as Accepted;
    const b = (await postChat(rt, lina, { text: "two" })).body as Accepted;

    expect(failStaleTurns(rt.db, time.clock)).toBe(2);
    expect(getTurn(rt.db, a.turnId)).toMatchObject({ status: "error", error_code: "SERVER_RESTARTED" });

    // The original tasks finishing later must not flip an already-failed turn back to done.
    gate.release();
    await Promise.all([rt.turnTasks.get(a.turnId), rt.turnTasks.get(b.turnId)]);
    expect(getTurn(rt.db, a.turnId)?.status).toBe("error");

    // A pending row whose task is gone (e.g. dev hot reload) is reported as interrupted, not polled forever.
    const c = (await postChat(rt, lina, { text: "three" })).body as Accepted;
    const task = rt.turnTasks.get(c.turnId);
    rt.turnTasks.delete(c.turnId);
    expect(getChatTurn(rt, lina, c.turnId).body).toMatchObject({ status: "error", error: { code: "INTERRUPTED" } });
    await task;
  });

  it("audits guarded calls exactly as before", async () => {
    const { rt } = mockRuntime();
    const a = (await postChat(rt, lina, { text: LARGE })).body as Accepted;
    await rt.turnTasks.get(a.turnId);
    expect(rt.audit.all().map((r) => r.event)).toEqual(["PROPOSED", "QUEUED"]);
    expect(rt.audit.verifyChain().ok).toBe(true);
  });
});
