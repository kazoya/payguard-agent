import type { ChatCompletionMessage, ChatCompletionMessageParam, ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import { minorToDecimalString, parseMoneyToMinor } from "@/lib/money";
import { detectLang, parseIntent, type Intent } from "./demoIntent";
import { say, type Lang } from "./demoText";
import { summarizeResults } from "./demoSummary";
import type { Llm } from "./llm";

/**
 * A deterministic, offline "LLM" for the mock demo and the eval suite. It turns one user message
 * into at most one tool call (with a plan sentence first), then summarizes the tool result.
 * It never needs a network or an API key.
 */

const usd = (v: string) => {
  const m = parseMoneyToMinor(v);
  return m === null ? v : `$${minorToDecimalString(m)}`;
};

function planFor(intent: Intent, lang: Lang): { text: string; name: string; args: Record<string, unknown> } | null {
  switch (intent.kind) {
    case "refund": {
      if (!intent.captureId) return null;
      const args: Record<string, unknown> = { capture_id: intent.captureId };
      if (intent.amount) args.amount = { currency_code: "USD", value: intent.amount };
      const amount = intent.amount ? usd(intent.amount) : say(lang, "plan.fullAmount");
      return { name: "create_refund", args, text: say(lang, "plan.refund", { amount, target: intent.captureId }) };
    }
    case "create_order": {
      if (!intent.amount) return null;
      const cost = Number(intent.amount);
      return {
        name: "create_order",
        args: { currencyCode: "USD", items: [{ name: intent.itemName, itemCost: cost, quantity: 1, taxPercent: 0, itemTotal: cost }] },
        text: say(lang, "plan.createOrder", { amount: usd(intent.amount), item: intent.itemName }),
      };
    }
    case "capture":
      return intent.orderId ? { name: "pay_order", args: { id: intent.orderId }, text: say(lang, "plan.capture", { target: intent.orderId }) } : null;
    case "get_order":
      return intent.orderId ? { name: "get_order", args: { id: intent.orderId }, text: "" } : null;
    case "list_transactions":
      return { name: "list_transactions", args: {}, text: "" };
    case "list_disputes":
      return { name: "list_disputes", args: {}, text: "" };
    case "policy":
      return { name: "explain_policy", args: {}, text: "" };
    case "approval_status":
      return { name: "check_approval_status", args: { approval_id: intent.approvalId }, text: "" };
    case "help":
      return null;
  }
}

function clarify(intent: Intent, lang: Lang): string {
  if (intent.kind === "refund") return say(lang, "ask.refund");
  if (intent.kind === "create_order") return say(lang, "ask.order");
  if (intent.kind === "capture" || intent.kind === "get_order") return say(lang, "ask.orderId");
  return say(lang, "help");
}

export class DemoLLM implements Llm {
  private counter = 0;

  async complete(messages: ChatCompletionMessageParam[]): Promise<ChatCompletionMessage> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const lang = detectLang(userText);
    const tail = messages.at(-1);

    if (tail?.role === "tool") {
      const results: unknown[] = [];
      for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "tool"; i--) {
        results.unshift(JSON.parse(String(messages[i]!.content)));
      }
      return { role: "assistant", content: summarizeResults(results, lang), refusal: null };
    }

    const intent = parseIntent(userText);
    const plan = planFor(intent, lang);
    if (!plan) return { role: "assistant", content: clarify(intent, lang), refusal: null };
    const call: ChatCompletionMessageToolCall = {
      id: `call_${++this.counter}`, type: "function", function: { name: plan.name, arguments: JSON.stringify(plan.args) },
    };
    return { role: "assistant", content: plan.text || null, refusal: null, tool_calls: [call] };
  }
}
