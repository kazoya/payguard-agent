// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutResult, orderTokenFrom } from "@/components/CheckoutResult";
import { translate } from "@/i18n";

afterEach(cleanup);

describe("checkout return/cancel pages", () => {
  it("only echoes tokens shaped like a PayPal order id", () => {
    expect(orderTokenFrom("3FY11740RF298331J")).toBe("3FY11740RF298331J");
    expect(orderTokenFrom(["3FY11740RF298331J", "X"])).toBe("3FY11740RF298331J");
    for (const bad of [undefined, "", "<script>", "abc", "3FY11740RF298331J; call support"]) expect(orderTokenFrom(bad)).toBeNull();
  });
  it("return page tells the user to ask the agent to capture the order", () => {
    render(<CheckoutResult kind="return" token="3FY11740RF298331J" lang="en" />);
    const page = screen.getByTestId("checkout-return");
    expect(page.textContent).toContain("Payment approved by the buyer");
    expect(page.textContent).toContain("ask the agent to capture order 3FY11740RF298331J");
    expect(page.querySelector('a[href="/"]')).not.toBeNull();
  });
  it("cancel page renders in Arabic without a token", () => {
    render(<CheckoutResult kind="cancel" token={null} lang="ar" />);
    expect(screen.getByTestId("checkout-cancel").textContent).toContain(translate("ar", "checkout.cancelTitle"));
  });
});
