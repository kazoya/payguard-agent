import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { approveApproval, rejectApproval } from "@/server/api/approvals";
import { postChat } from "@/server/api/chat";
import type { DisplayCard, DisplayMessage } from "@/server/chatService";
import { buildMockRuntime, type Runtime } from "@/server/runtime";
import { DEMO_USERS, type DemoUser } from "@/server/users";

/**
 * Offline eval: each scenario runs end to end (chat API -> DemoLLM -> PolicyGuard -> MockPayPal -> audit)
 * on a fresh in-memory runtime with a fixed clock. Policy-level assertions are deterministic.
 */

const Role = z.enum(["clerk", "approver", "owner"]);
const Decision = z.enum(["ALLOW", "REQUIRE_APPROVAL", "DENY"]);
const Capture = z.object({ id: z.string(), amount: z.string() });

const Expect = z.object({
  tool: z.string().optional(),
  decision: Decision.optional(),
  ruleId: z.string().optional(),
  reply_lang: z.enum(["en", "ar"]).optional(),
  tool_executed: z.boolean().optional(),
  no_tool: z.boolean().optional(),
  reply_matches: z.string().optional(),
});
type ExpectT = z.infer<typeof Expect>;

const Then = z.object({
  as: Role,
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
  advance_hours: z.number().optional(),
  expect: z.object({ status: z.string().optional(), error: z.string().optional(), executed: z.boolean().optional() }),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  role: Role,
  setup: z.object({ capture: Capture.optional(), captures: z.array(Capture).optional() }).default({}),
  before: z.array(z.string()).default([]),
  user: z.string().min(1),
  customer_message: z.string().optional(),
  expect: Expect.extend({ any_of: z.array(Expect).optional() }),
  then: z.array(Then).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export type Observed = {
  tool: string | null; decision: string | null; ruleId: string | null; replyLang: "en" | "ar";
  toolExecuted: boolean; reply: string; cards: number;
};
export type ScenarioResult = { id: string; file: string; pass: boolean; failures: string[]; observed: Observed };

const ARABIC = /[\u0600-\u06FF]/;
const DECISION_BY_STATUS: Record<string, string> = { executed: "ALLOW", failed: "ALLOW", pending_approval: "REQUIRE_APPROVAL", denied: "DENY" };

export function loadScenarios(dir: string): { file: string; scenario: Scenario }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .flatMap((file) => {
      const docs = z.array(z.unknown()).parse(parseYaml(readFileSync(path.join(dir, file), "utf8")));
      return docs.map((d) => ({ file, scenario: ScenarioSchema.parse(d) }));
    });
}

const userFor = (role: string): DemoUser => DEMO_USERS.find((u) => u.role === role)!;

function fixedClock(start = "2026-10-24T09:00:00.000Z") {
  let now = new Date(start).getTime();
  return { clock: () => new Date(now), advanceHours: (h: number) => { now += h * 3_600_000; } };
}

function lastRuleId(rt: Runtime, auditFrom: number): string | null {
  const rows = rt.audit.all().slice(auditFrom).reverse();
  for (const r of rows) {
    const id = r.detail_json ? (JSON.parse(r.detail_json) as { ruleId?: unknown }).ruleId : undefined;
    if (typeof id === "string") return id;
  }
  return null;
}

function check(e: ExpectT, o: Observed): string[] {
  const f: string[] = [];
  const cmp = (name: string, want: unknown, got: unknown) => { if (want !== undefined && want !== got) f.push(`${name}: want ${String(want)}, got ${String(got)}`); };
  cmp("tool", e.tool, o.tool);
  cmp("decision", e.decision, o.decision);
  cmp("ruleId", e.ruleId, o.ruleId);
  cmp("reply_lang", e.reply_lang, o.replyLang);
  cmp("tool_executed", e.tool_executed, o.toolExecuted);
  if (e.no_tool && o.cards > 0) f.push(`no_tool: got ${o.cards} card(s)`);
  if (e.reply_matches && !new RegExp(e.reply_matches, "i").test(o.reply)) f.push(`reply_matches /${e.reply_matches}/ failed`);
  return f;
}

export async function runScenario(s: Scenario, file = ""): Promise<ScenarioResult> {
  const time = fixedClock();
  const captures = s.setup.captures ?? (s.setup.capture ? [s.setup.capture] : undefined);
  const rt = buildMockRuntime({ clock: time.clock, captures });
  const user = userFor(s.role);
  let conversationId: string | undefined;

  for (const text of s.before) {
    const r = await postChat(rt, user, { conversationId, text });
    conversationId = (r.body as { conversationId: string }).conversationId;
  }
  const callsBefore = rt.mockPayPal!.calls.length;
  const auditFrom = rt.audit.all().length;
  const text = s.customer_message ? `${s.user}\n<customer_message>${s.customer_message}</customer_message>` : s.user;
  const res = await postChat(rt, user, { conversationId, text });
  const msgs = (res.body as { messages?: DisplayMessage[] }).messages ?? [];
  const last = msgs.filter((m) => m.role === "assistant").at(-1);
  const card: DisplayCard | undefined = last?.cards[0];

  const observed: Observed = {
    tool: card?.tool ?? null,
    decision: card ? DECISION_BY_STATUS[card.status] ?? card.status : null,
    ruleId: card?.ruleId ?? (card ? lastRuleId(rt, auditFrom) : null),
    replyLang: ARABIC.test(last?.text ?? "") ? "ar" : "en",
    toolExecuted: rt.mockPayPal!.calls.length > callsBefore,
    reply: last?.text ?? "",
    cards: last?.cards.length ?? 0,
  };

  let failures = res.status === 200 ? [] : [`chat returned ${res.status}`];
  const { any_of: anyOf, ...main } = s.expect;
  failures.push(...check(main, observed));
  if (anyOf && !anyOf.some((alt) => check(alt, observed).length === 0)) failures.push("any_of: no alternative matched");

  for (const step of s.then) {
    if (!card?.approvalId) { failures.push("then: no approval id"); break; }
    if (step.advance_hours) time.advanceHours(step.advance_hours);
    const actor = userFor(step.as);
    const callsAtStep = rt.mockPayPal!.calls.length;
    const r = step.action === "approve"
      ? await approveApproval(rt, actor, card.approvalId, {})
      : rejectApproval(rt, actor, card.approvalId, step.reason === undefined ? {} : { reason: step.reason });
    const body = r.body as { approval?: { status: string }; error?: { code: string } };
    if (step.expect.status && body.approval?.status !== step.expect.status) failures.push(`then.status: want ${step.expect.status}, got ${body.approval?.status ?? body.error?.code}`);
    if (step.expect.error && body.error?.code !== step.expect.error) failures.push(`then.error: want ${step.expect.error}, got ${body.error?.code ?? body.approval?.status}`);
    const executed = rt.mockPayPal!.calls.length > callsAtStep;
    if (step.expect.executed !== undefined && executed !== step.expect.executed) failures.push(`then.executed: want ${step.expect.executed}, got ${executed}`);
  }
  if (!rt.audit.verifyChain().ok) failures.push("audit chain broken");
  failures = failures.filter(Boolean);
  return { id: s.id, file, pass: failures.length === 0, failures, observed };
}
