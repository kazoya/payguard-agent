import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Actor, ApprovalQueue } from "@/approvals/queue";
import type { Store } from "@/db/store";
import type { Policy } from "@/guard/policy";
import type { GuardOutcome, PolicyGuard } from "@/guard/policyGuard";
import { deriveProvenance, splitTrustedText } from "@/guard/provenance";
import { minorToDecimalString } from "@/lib/money";
import type { Llm } from "./llm";
import { buildPlanCard, type PlanCard } from "./planCard";
import { LOCAL_TOOL_NAMES, LOCAL_TOOLS, SYSTEM_PROMPT } from "./prompts";

/**
 * One agent turn: LLM -> tool calls -> PolicyGuard -> structured results back to the LLM,
 * at most `maxSteps` LLM calls. The model never executes anything itself.
 */

export const MAX_STEPS = 6;

export type AgentDeps = {
  llm: Llm;
  guard: PolicyGuard;
  approvals: ApprovalQueue;
  store: Store;
  policy: Policy;
  paypalTools: ChatCompletionTool[];
  maxSteps?: number;
};

export type AgentTurnInput = {
  actor: Actor;
  conversationId: string | null;
  history: ChatCompletionMessageParam[];
  userText: string;
};

export type AgentTurnResult = {
  reply: string;
  messages: ChatCompletionMessageParam[];
  outcomes: GuardOutcome[];
  /** One card per guarded PayPal call (local tools excluded), in call order. */
  cards: PlanCard[];
  steps: number;
  stoppedAtLimit: boolean;
};

export const STEP_LIMIT_REPLY = "I stopped after the maximum number of steps for one message. Please check the results above or rephrase.";

/** What the model sees for a guarded call: status first, minimal detail, no raw errors. */
export function toModelResult(o: GuardOutcome): Record<string, unknown> {
  switch (o.status) {
    case "executed":
      return { status: "executed", tool: o.tool, data: o.data };
    case "failed":
      return { status: "failed", tool: o.tool, error: { code: o.error.code, message: o.error.message } };
    case "pending_approval":
      return { status: "pending_approval", tool: o.tool, approval_id: o.approvalId, rule: o.ruleId, reason: o.reason };
    case "denied":
      return { status: "denied", tool: o.tool, rule: o.ruleId, reason: o.reason };
  }
}

function policySummary(policy: Policy): Record<string, unknown> {
  const usd = (m: number | undefined) => (m === undefined ? undefined : minorToDecimalString(m));
  return {
    currency: policy.currency,
    daily_refund_cap: usd(policy.limits.daily_refund_cap),
    rules: policy.rules.map((r) => ({
      id: r.id, tools: r.tools, decision: r.decision, reason: r.reason,
      amount_gt: usd(r.when?.amount_gt), amount_lte: usd(r.when?.amount_lte),
    })),
  };
}

function textOf(m: ChatCompletionMessageParam): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => ("text" in p ? p.text : "")).join("\n");
  return "";
}

export async function runAgentTurn(deps: AgentDeps, input: AgentTurnInput): Promise<AgentTurnResult> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS;
  const tools = [...deps.paypalTools, ...LOCAL_TOOLS] as ChatCompletionTool[];
  const userMsg: ChatCompletionMessageParam = { role: "user", content: input.userText };
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }, ...input.history, userMsg];
  const trustedText = [...input.history, userMsg].filter((m) => m.role === "user").map((m) => splitTrustedText(textOf(m)).trusted).join("\n");
  let fetchedText = input.history.filter((m) => m.role === "tool").map(textOf).join("\n");
  const outcomes: GuardOutcome[] = [];
  const cards: PlanCard[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const reply = await deps.llm.complete(messages, tools);
    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      const content = reply.content ?? "";
      messages.push({ role: "assistant", content });
      return { reply: content, messages, outcomes, cards, steps: step, stoppedAtLimit: false };
    }
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const result = await dispatch(deps, input.actor, input.conversationId, call.function.name, call.function.arguments, {
        trustedText, fetchedText, outcomes,
      });
      if (!LOCAL_TOOL_NAMES.has(call.function.name)) {
        cards.push(buildPlanCard({ id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) }, reply.content ?? null, result, deps.store));
      }
      const content = JSON.stringify(result);
      if (result.status === "executed") fetchedText += `\n${content}`;
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  messages.push({ role: "assistant", content: STEP_LIMIT_REPLY });
  return { reply: STEP_LIMIT_REPLY, messages, outcomes, cards, steps: maxSteps, stoppedAtLimit: true };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function dispatch(
  deps: AgentDeps,
  actor: Actor,
  conversationId: string | null,
  name: string,
  rawArgs: string,
  ctx: { trustedText: string; fetchedText: string; outcomes: GuardOutcome[] },
): Promise<Record<string, unknown>> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    args = parsed as Record<string, unknown>;
  } catch {
    return { status: "denied", tool: name, rule: "INVALID_ARGS", reason: "Tool arguments must be a JSON object." };
  }

  if (LOCAL_TOOL_NAMES.has(name)) {
    if (name === "explain_policy") return { status: "executed", tool: name, data: policySummary(deps.policy) };
    const row = deps.approvals.get(String(args.approval_id ?? ""));
    return row
      ? { status: "executed", tool: name, data: { approval_id: row.id, status: row.status, tool: row.tool, reason: row.reason } }
      : { status: "failed", tool: name, error: { code: "NOT_FOUND", message: "No approval with that id." } };
  }

  const provenance = deriveProvenance(name, args, {
    trustedText: ctx.trustedText,
    fetchedText: ctx.fetchedText,
    isKnownObject: (id) => deps.store.getObject(id) !== undefined,
    knownAmountsMinor: deps.store.knownAmountsMinor(),
  });
  const outcome = await deps.guard.handle({ actor, conversationId, tool: name, args, provenance });
  ctx.outcomes.push(outcome);
  return toModelResult(outcome);
}
