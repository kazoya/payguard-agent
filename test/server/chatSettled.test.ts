import { describe, expect, it } from "vitest";
import type { Llm } from "@/agent/llm";
import { getChatTurn, postChatSettled, runningTurns } from "@/server/api/chat";
import type { DisplayMessage } from "@/server/chatService";
import { INJECTION, LARGE, lina, mockRuntime, SMALL } from "./helpers";

type Body = { conversationId: string; turnId: string; status: string; messages: DisplayMessage[] };
const lastCard = (b: Body) => b.messages.filter((m) => m.role === "assistant").at(-1)!.cards[0]!;

describe("postChatSettled (hosted mock demo)", () => {
  it("returns the finished turn in one request in mock mode, through the same guarded path", async () => {
    const { rt } = mockRuntime();
    const small = await postChatSettled(rt, lina, { text: SMALL });
    expect(small.status).toBe(200);
    expect(small.body).toMatchObject({ status: "done", error: null });
    expect(lastCard(small.body as Body)).toMatchObject({ tool: "create_refund", status: "executed", amountMinor: 2000 });

    const large = (await postChatSettled(rt, lina, { conversationId: (small.body as Body).conversationId, text: LARGE })).body as Body;
    expect(lastCard(large)).toMatchObject({ status: "pending_approval", ruleId: "refund-large" });

    const inj = (await postChatSettled(rt, lina, { text: INJECTION })).body as Body;
    expect(lastCard(inj)).toMatchObject({ status: "denied", ruleId: "UNTRUSTED_SOURCE" });
    // Same body as the polling endpoint.
    expect(getChatTurn(rt, lina, inj.turnId).body).toEqual(inj);
  });

  it("keeps 202 + polling when the turn outlasts the wait", async () => {
    const { rt } = mockRuntime();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    rt.llm = { complete: async () => { await gate; return { role: "assistant", content: "All done.", refusal: null } as never; } } satisfies Llm;
    const res = await postChatSettled(rt, lina, { text: "Explain the policy" }, 20);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "pending" });
    release();
    await runningTurns(rt);
    expect(getChatTurn(rt, lina, (res.body as Body).turnId).body).toMatchObject({ status: "done" });
  });

  it("passes validation errors through unchanged", async () => {
    const { rt } = mockRuntime();
    expect((await postChatSettled(rt, lina, { text: "" })).status).toBe(400);
  });

  it("does not wait in sandbox mode", async () => {
    const { rt } = mockRuntime();
    rt.mode = { paypal: "sandbox", llm: "demo" };
    const res = await postChatSettled(rt, lina, { text: SMALL });
    expect(res.status).toBe(202);
    await runningTurns(rt);
  });
});
