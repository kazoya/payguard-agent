import type { ChatCompletionMessageToolCall, ChatCompletionTool, ChatCompletionToolMessageParam } from "openai/resources";
import { minorToDecimalString, parseMoneyToMinor } from "@/lib/money";
import { extractMoneyFacts } from "@/guard/toolArgs";
import { disputeList, transactionSearch, type MockCaptureState, type MockRefundState } from "./mockData";
import { TOOL_ALLOWLIST } from "./toolkit";
import type { ToolCallHandler, ToolCallHandlerFactory } from "./types";

/**
 * In-memory PayPal stand-in for tests and offline evals. It honours PayPal-Request-Id like the
 * real API: a repeated request id returns the first response instead of acting twice.
 */

export type MockCall = { tool: string; args: Record<string, unknown>; requestId?: string };


export class MockPayPal {
  readonly calls: MockCall[] = [];
  private readonly captures = new Map<string, MockCaptureState>();
  private readonly refunds: MockRefundState[] = [];
  private readonly orders = new Map<string, { id: string; status: string; amountMinor: number }>();
  private readonly byRequestId = new Map<string, string>();
  private counter = 0;
  /** Set to force the next call to fail like a PayPal 4xx/5xx. */
  failNext: { status: number; message: string } | null = null;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private now(): string {
    return this.clock().toISOString();
  }

  addCapture(id: string, amount: string): void {
    const minor = parseMoneyToMinor(amount);
    if (minor === null) throw new Error("bad amount");
    this.captures.set(id, { id, amountMinor: minor, refundedMinor: 0, createdAt: this.now() });
  }

  /** Number of calls that actually acted (not replays of a request id). */
  get effectiveCalls(): number {
    return this.byRequestId.size + this.calls.filter((c) => !c.requestId).length;
  }

  factory: ToolCallHandlerFactory = ({ requestId }) => this.handler(requestId);

  handler(requestId?: string): ToolCallHandler {
    return {
      getTools: () => TOOL_ALLOWLIST.map((name): ChatCompletionTool => ({ type: "function", function: { name, parameters: {} } })),
      handleToolCall: async (call: ChatCompletionMessageToolCall): Promise<ChatCompletionToolMessageParam> => ({
        role: "tool",
        tool_call_id: call.id,
        content: this.run(call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>, requestId),
      }),
    };
  }

  private run(tool: string, args: Record<string, unknown>, requestId?: string): string {
    this.calls.push({ tool, args, requestId });
    if (requestId && this.byRequestId.has(requestId)) return this.byRequestId.get(requestId)!;
    const out = JSON.stringify(this.act(tool, args));
    if (requestId) this.byRequestId.set(requestId, out);
    return out;
  }

  private act(tool: string, args: Record<string, unknown>): unknown {
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return { ok: false, code: "PAYPAL_API_HTTP_ERROR", status: f.status, message: f.message };
    }
    const nextId = (prefix: string) => `${prefix}${String(++this.counter).padStart(15, "0")}`;
    switch (tool) {
      case "create_order": {
        const facts = extractMoneyFacts(tool, args);
        const amountMinor = facts.ok && facts.value.amountMinor !== null ? facts.value.amountMinor : 0;
        const id = nextId("MOCKORDER");
        this.orders.set(id, { id, status: "CREATED", amountMinor });
        return { id, status: "CREATED", links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
      }
      case "get_order": {
        const o = this.orders.get(String(args.id));
        return o ? { id: o.id, status: o.status } : { error: { message: "RESOURCE_NOT_FOUND" } };
      }
      case "pay_order": {
        const o = this.orders.get(String(args.id));
        if (!o) return { error: { message: "RESOURCE_NOT_FOUND" } };
        o.status = "COMPLETED";
        const capId = nextId("MOCKCAPTURE");
        this.captures.set(capId, { id: capId, amountMinor: o.amountMinor, refundedMinor: 0, createdAt: this.now() });
        const amount = { currency_code: "USD", value: minorToDecimalString(o.amountMinor) };
        return { id: o.id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: capId, status: "COMPLETED", amount }] } }] };
      }
      case "create_refund": {
        const cap = this.captures.get(String(args.capture_id));
        if (!cap) return { error: { message: "RESOURCE_NOT_FOUND" } };
        const amount = args.amount as { value: string } | undefined;
        const minor = amount ? parseMoneyToMinor(amount.value) ?? 0 : cap.amountMinor - cap.refundedMinor;
        cap.refundedMinor += minor;
        const refundId = nextId("MOCKREFUND");
        this.refunds.push({ id: refundId, captureId: cap.id, amountMinor: minor, createdAt: this.now() });
        return { id: refundId, status: "COMPLETED", amount: { currency_code: "USD", value: minorToDecimalString(minor) } };
      }
      case "list_transactions":
        return transactionSearch([...this.captures.values()], this.refunds);
      case "list_disputes":
        return disputeList([...this.captures.values()], this.now());
      case "get_refund": {
        const ref = this.refunds.find((x) => x.id === String(args.refund_id ?? args.id));
        return ref ? { id: ref.id, status: "COMPLETED", amount: { currency_code: "USD", value: minorToDecimalString(ref.amountMinor) } } : { error: { message: "RESOURCE_NOT_FOUND" } };
      }
      default:
        return { tool, ok: true, items: [] };
    }
  }

  refundedMinor(captureId: string): number {
    return this.captures.get(captureId)?.refundedMinor ?? 0;
  }
}
