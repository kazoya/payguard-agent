import { describe, expect, it } from "vitest";
import { summarizeResults } from "@/agent/demoSummary";

const LINK = "https://www.sandbox.paypal.com/checkoutnow?token=3FY11740RF298331J";

describe("demo summary of checkout results", () => {
  it("shares only the verified checkout_url, never PayPal's raw links", () => {
    const text = summarizeResults([{ status: "executed", tool: "create_order", data: { id: "3FY11740RF298331J", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://evil.example/x" }] }, checkout_url: LINK }], "en");
    expect(text).toContain(LINK);
    expect(text).toContain("capture order 3FY11740RF298331J");
    expect(text).not.toContain("evil.example");
  });
  it("says so when there is no verified link", () => {
    const text = summarizeResults([{ status: "executed", tool: "create_order", data: { id: "O1", status: "PAYER_ACTION_REQUIRED" } }], "ar");
    expect(text).not.toContain("http");
    expect(text).toContain("O1");
  });
  it("reports the capture id and status after pay_order", () => {
    const text = summarizeResults([{ status: "executed", tool: "pay_order", data: { id: "O1", status: "COMPLETED" }, capture: { id: "CAP9", status: "COMPLETED" } }], "en");
    expect(text).toContain("CAP9");
    expect(text).toContain("COMPLETED");
  });
});
