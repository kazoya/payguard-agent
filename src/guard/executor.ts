import { extractMoneyFacts } from "./toolArgs";
import { isAllowedTool } from "@/paypal/toolkit";
import type { ToolCallHandlerFactory } from "@/paypal/types";
import { err, ok, type Result } from "@/lib/result";

/**
 * The ONLY module that calls toolkit.handleToolCall. It re-checks the invariants that must hold
 * even if the policy layer had a bug (defense in depth), and sends a PayPal-Request-Id per action.
 */

export type ExecRequest = { tool: string; args: Record<string, unknown>; requestId: string };

export type ExecErrorCode = "TOOL_NOT_ALLOWED" | "AMOUNT_REQUIRED" | "CURRENCY_NOT_USD" | "INVALID_ARGS" | "PAYPAL_ERROR";
export type ExecError = { code: ExecErrorCode; message: string; status?: number };
export type ExecSuccess = { data: unknown; raw: string };

export type Executor = { execute(req: ExecRequest): Promise<Result<ExecSuccess, ExecError>> };

/** The toolkit only accepts USD orders; refunds must match the capture currency, which is USD in the demo. */
const REQUIRED_CURRENCY = "USD";

export function preflight(req: ExecRequest): ExecError | null {
  if (!isAllowedTool(req.tool)) return { code: "TOOL_NOT_ALLOWED", message: `Tool "${req.tool}" is not allowlisted` };
  if (!req.requestId) return { code: "INVALID_ARGS", message: "requestId is required" };
  if (req.tool === "create_refund" || req.tool === "create_order") {
    const facts = extractMoneyFacts(req.tool, req.args);
    if (!facts.ok) return { code: "INVALID_ARGS", message: facts.error };
    // Without an amount, PayPal refunds the FULL capture.
    if (facts.value.amountMinor === null) return { code: "AMOUNT_REQUIRED", message: "create_refund needs an explicit amount" };
    if (facts.value.currency !== REQUIRED_CURRENCY) {
      return { code: "CURRENCY_NOT_USD", message: `${req.tool} must use ${REQUIRED_CURRENCY}` };
    }
  }
  return null;
}

export function createExecutor(handlerFactory: ToolCallHandlerFactory): Executor {
  return {
    async execute(req) {
      const blocked = preflight(req);
      if (blocked) return err(blocked);
      const handler = handlerFactory({ requestId: req.requestId });
      const message = await handler.handleToolCall({
        id: req.requestId,
        type: "function",
        function: { name: req.tool, arguments: JSON.stringify(req.args) },
      });
      const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return interpretToolkitResponse(raw);
    },
  };
}

/** The toolkit never throws; it returns JSON with `error` or `{ok:false,...}` on failure. */
export function interpretToolkitResponse(raw: string): Result<ExecSuccess, ExecError> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return err({ code: "PAYPAL_ERROR", message: "Unparseable toolkit response" });
  }
  if (data && typeof data === "object") {
    const o = data as { ok?: unknown; error?: { message?: unknown }; message?: unknown; status?: unknown };
    if (o.ok === false || o.error !== undefined) {
      const message = String(o.error?.message ?? o.message ?? "PayPal call failed").slice(0, 300);
      return err({ code: "PAYPAL_ERROR", message, ...(typeof o.status === "number" ? { status: o.status } : {}) });
    }
  }
  return ok({ data, raw });
}
