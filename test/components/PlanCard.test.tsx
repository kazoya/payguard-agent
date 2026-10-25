// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanCard } from "@/components/PlanCard";
import { translate, type Lang } from "@/i18n";
import type { DisplayCard } from "@/server/chatService";

afterEach(cleanup);

const base: DisplayCard = {
  callId: "call_1", tool: "create_refund", plan: "Plan: refund $120.00 on capture 2GG279541U471931P.", amountMinor: 12000, currency: "USD",
  target: "2GG279541U471931P", status: "pending_approval", ruleId: "refund-large", reason: "Refunds over $100 need a manager.",
  approvalId: "apr_0e3c2f1a-1111-4222-8333-444455556666", resultId: null, error: null, approvalStatus: "PENDING",
};

const renderCard = (card: DisplayCard, lang: Lang = "en") =>
  render(<PlanCard card={card} lang={lang} t={(k, v) => translate(lang, k, v)} />);

describe("<PlanCard>", () => {
  it("shows the plan, amount, target, rule, reason and approval link for a pending action", () => {
    renderCard(base);
    const card = screen.getByTestId("plan-card");
    expect(within(card).getByText(base.plan!)).toBeTruthy();
    expect(within(card).getByText("$120.00")).toBeTruthy();
    expect(within(card).getByText("refund-large")).toBeTruthy();
    expect(within(card).getByText(base.reason!)).toBeTruthy();
    expect(card.querySelector('a[href="/approvals"]')).not.toBeNull();
    const badges = within(card).getAllByTestId("status-badge");
    expect(badges.map((b) => b.getAttribute("data-status"))).toEqual(["pending_approval"]);
  });

  it("adds a live badge once the approval was decided", () => {
    renderCard({ ...base, approvalStatus: "EXECUTED" });
    const badges = screen.getAllByTestId("status-badge").map((b) => b.getAttribute("data-status"));
    expect(badges).toEqual(["pending_approval", "EXECUTED"]);
  });

  it("renders a denied card with its rule and no approval link", () => {
    renderCard({ ...base, status: "denied", ruleId: "UNTRUSTED_SOURCE", approvalId: null, approvalStatus: null, amountMinor: 90000 });
    expect(screen.getByTestId("status-badge").getAttribute("data-status")).toBe("denied");
    expect(screen.getByText("UNTRUSTED_SOURCE")).toBeTruthy();
    expect(screen.getByTestId("plan-card").querySelector("a")).toBeNull();
  });

  it("uses the Arabic dictionary and keeps ids left-to-right", () => {
    renderCard({ ...base, status: "executed", ruleId: null, reason: null, approvalId: null, approvalStatus: null, resultId: "MOCKREFUND0001" }, "ar");
    expect(screen.getByText(translate("ar", "status.executed"))).toBeTruthy();
    expect(screen.getByText(translate("ar", "card.target"))).toBeTruthy();
    expect(screen.getByText("MOCKREFUND0001").closest("bdi")?.getAttribute("dir")).toBe("ltr");
  });

  it("falls back to 'full remaining amount' for refunds without an amount", () => {
    renderCard({ ...base, amountMinor: null, currency: null });
    expect(screen.getByText(translate("en", "card.fullAmount"))).toBeTruthy();
  });
});

describe("<PlanCard> in Arabic", () => {
  it("shows the translated reason for a known rule id", () => {
    renderCard(base, "ar");
    expect(screen.getByText(translate("ar", "reason.refund-large"))).toBeTruthy();
    expect(screen.queryByText(base.reason!)).toBeNull();
  });
});
