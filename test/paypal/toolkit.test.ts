import { describe, expect, it } from "vitest";
import {
  assertSandboxToolkit, buildToolkitConfiguration, createToolkit, SANDBOX_API_BASE, SandboxViolationError, TOOL_ALLOWLIST,
} from "@/paypal/toolkit";

// Fake credentials: constructing the toolkit does not call PayPal.
const creds = { clientId: "fake-id", clientSecret: "fake-secret" };

describe("PayPal toolkit (sandbox-forced)", () => {
  it("always passes sandbox: true and the request id", () => {
    expect(buildToolkitConfiguration().context).toEqual({ sandbox: true });
    expect(buildToolkitConfiguration("apr_1").context).toEqual({ sandbox: true, request_id: "apr_1" });
  });

  it("only enables allowlisted actions", () => {
    expect(buildToolkitConfiguration().actions).toEqual({
      orders: { create: true, get: true, capture: true },
      payments: { createRefund: true, getRefunds: true },
      disputes: { list: true, get: true },
      transactions: { list: true },
    });
  });

  it("exposes exactly the allowlisted tools and points at the sandbox", () => {
    const tk = createToolkit(creds);
    expect(tk.getTools().map((t) => t.function.name).sort()).toEqual([...TOOL_ALLOWLIST].sort());
    expect(new URL(tk.client.getBaseUrl()).hostname).toMatch(/\.sandbox\.paypal\.com$/);
    expect(SANDBOX_API_BASE).toBe("https://api-m.sandbox.paypal.com");
  });

  it("refuses a toolkit pointed at live or exposing extra tools", () => {
    const tools = [{ type: "function" as const, function: { name: "get_order" } }];
    expect(() => assertSandboxToolkit({ client: { getBaseUrl: () => "https://api-m.paypal.com" }, getTools: () => tools })).toThrow(SandboxViolationError);
    expect(() =>
      assertSandboxToolkit({
        client: { getBaseUrl: () => SANDBOX_API_BASE },
        getTools: () => [...tools, { type: "function" as const, function: { name: "create_invoice" } }],
      }),
    ).toThrow(/create_invoice/);
  });
});
