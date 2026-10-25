import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import type { PayPalCredentials } from "@/config/env";
import type { ToolCallHandlerFactory } from "./types";

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

/** Least privilege: only the toolkit actions SPEC section 6 needs for the MVP. */
export const TOOLKIT_ACTIONS = {
  orders: { create: true, get: true, capture: true },
  payments: { createRefund: true, getRefunds: true },
  disputes: { list: true, get: true },
  transactions: { list: true },
} as const;

export const TOOL_ALLOWLIST = [
  "create_order",
  "get_order",
  "pay_order",
  "create_refund",
  "get_refund",
  "list_disputes",
  "get_dispute",
  "list_transactions",
] as const;
export type AllowedTool = (typeof TOOL_ALLOWLIST)[number];

export function isAllowedTool(name: string): name is AllowedTool {
  return (TOOL_ALLOWLIST as readonly string[]).includes(name);
}

export class SandboxViolationError extends Error {
  override name = "SandboxViolationError";
}

/** Exposed for tests: the exact configuration passed to the toolkit. */
export function buildToolkitConfiguration(requestId?: string) {
  return {
    actions: structuredClone(TOOLKIT_ACTIONS) as unknown as Record<string, Record<string, boolean>>,
    // The toolkit defaults to LIVE (`context.sandbox ?? false`); sandbox must always be explicit.
    context: { sandbox: true as const, ...(requestId ? { request_id: requestId } : {}) },
  };
}

export function createToolkit(creds: PayPalCredentials, opts: { requestId?: string } = {}): PayPalAgentToolkit {
  const toolkit = new PayPalAgentToolkit({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    configuration: buildToolkitConfiguration(opts.requestId),
  });
  assertSandboxToolkit(toolkit);
  return toolkit;
}

/** Fails closed if a toolkit upgrade ever changes the base URL or exposes extra tools. */
export function assertSandboxToolkit(toolkit: Pick<PayPalAgentToolkit, "getTools"> & { client: { getBaseUrl(): string } }): void {
  const base = new URL(toolkit.client.getBaseUrl());
  if (!base.hostname.endsWith(".sandbox.paypal.com")) {
    throw new SandboxViolationError("PayPal toolkit is not pointed at the sandbox");
  }
  const extra = toolkit.getTools().map((t) => t.function.name).filter((n) => !isAllowedTool(n));
  if (extra.length > 0) throw new SandboxViolationError(`Toolkit exposes non-allowlisted tools: ${extra.join(", ")}`);
}

export function toolkitHandlerFactory(creds: PayPalCredentials): ToolCallHandlerFactory {
  return ({ requestId }) => createToolkit(creds, { requestId });
}
