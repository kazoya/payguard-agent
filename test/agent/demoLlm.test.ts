import { describe, expect, it } from "vitest";
import { detectLang, firstAmount, idsIn, normalizeDigits, parseIntent } from "@/agent/demoIntent";
import { DemoLLM } from "@/agent/demoLlm";
import ar from "../fixtures/arabic-inputs.json";

describe("demo intent parser", () => {
  it("parses an English refund with amount and capture id", () => {
    expect(parseIntent("Refund $20 on capture 8MC585209K746392H")).toEqual({ kind: "refund", captureId: "8MC585209K746392H", amount: "20", full: false });
  });

  it("parses an Arabic refund, including Arabic-Indic digits", () => {
    expect(parseIntent(ar.refund30)).toMatchObject({ kind: "refund", captureId: "8MC585209K746392H", amount: "30" });
    expect(parseIntent(ar.refundIndicDigits)).toMatchObject({ kind: "refund", amount: "25" });
    expect(normalizeDigits("\u0662\u0665\u066B\u0665")).toBe("25.5");
  });

  it("ignores digits inside ids when looking for amounts", () => {
    expect(firstAmount("refund capture 8MC585209K746392H")).toBeNull();
    expect(idsIn("capture 8MC585209K746392H and SYSTEM")).toEqual(["8MC585209K746392H"]);
  });

  it("marks a full refund without amount", () => {
    expect(parseIntent("Refund capture CAPTURE_FIXTURE_1 fully.")).toMatchObject({ kind: "refund", amount: null, full: true });
  });

  it("parses create order, capture, policy, lists and approval status", () => {
    expect(parseIntent("Create a $35 order for a Coffee mug")).toMatchObject({ kind: "create_order", amount: "35", itemName: "Coffee mug" });
    expect(parseIntent("Capture order MOCKORDER000000000000001")).toMatchObject({ kind: "capture", orderId: "MOCKORDER000000000000001" });
    expect(parseIntent("What is the refund policy?").kind).toBe("policy");
    expect(parseIntent("Explain the policy limits").kind).toBe("policy");
    expect(parseIntent(ar.policy).kind).toBe("policy");
    expect(parseIntent("Show recent transactions").kind).toBe("list_transactions");
    expect(parseIntent("Any open disputes?").kind).toBe("list_disputes");
    expect(parseIntent("status of apr_0e3c2f1a-1111-4222-8333-444455556666").kind).toBe("approval_status");
    expect(parseIntent("hello").kind).toBe("help");
  });

  it("detects the reply language from trusted text only", () => {
    expect(detectLang(ar.refund30)).toBe("ar");
    expect(detectLang("Handle this <customer_message>\u0646\u0635 \u0639\u0631\u0628\u064A</customer_message>")).toBe("en");
  });
});

describe("DemoLLM", () => {
  it("emits one tool call with a plan sentence, then summarizes the tool result", async () => {
    const llm = new DemoLLM();
    const first = await llm.complete([{ role: "user", content: "Refund $20 on capture 8MC585209K746392H" }]);
    expect(first.tool_calls?.[0]?.function.name).toBe("create_refund");
    expect(JSON.parse(first.tool_calls![0]!.function.arguments)).toEqual({ capture_id: "8MC585209K746392H", amount: { currency_code: "USD", value: "20" } });
    expect(first.content).toMatch(/^Plan: refund \$20\.00/);

    const second = await llm.complete([
      { role: "user", content: "Refund $20 on capture 8MC585209K746392H" },
      { role: "assistant", content: first.content, tool_calls: first.tool_calls },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ status: "denied", tool: "create_refund", rule: "X", reason: "nope" }) },
    ]);
    expect(second.tool_calls).toBeUndefined();
    expect(second.content).toBe("Blocked by policy (X): nope");
  });

  it("asks a question instead of guessing when the capture id is missing", async () => {
    const r = await new DemoLLM().complete([{ role: "user", content: "refund 20 dollars" }]);
    expect(r.tool_calls).toBeUndefined();
    expect(r.content).toMatch(/capture id/);
  });
});
