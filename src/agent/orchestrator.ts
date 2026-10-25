import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Actor, ApprovalQueue } from "@/approvals/queue";
import type { Store } from "@/db/store";
import type { Policy } from "@/guard/policy";
import type { GuardOutcome, PolicyGuard } from "@/guard/policyGuard";
import { invalidArgsFeedback, TOOL_EXAMPLES, ARG_TYPE_HINT } from "@/guard/argFeedback";
import { normalizeToolArgs, parseRawArgs } from "@/guard/argNormalize";
import { deriveProvenance, splitTrustedText } from "@/guard/provenance";
import { minorToDecimalString } from "@/lib/money";
import type { Llm } from "./llm";
import { buildPlanCard, type PlanCard } from "./planCard";
import { LOCAL_TOOL_NAMES, LOCAL_TOOLS, SYSTEM_PROMPT } from "./prompts";
import { extractTextToolCalls, hasToolMarkup, stripToolMarkup } from "./textToolCalls";

/**
 * One agent turn: LLM -> tool calls -> PolicyGuard -> structured results back to the LLM,
 * at most `maxSteps` LLM calls. The model never executes anything itself.
 * Six steps leave room for a read, an action and one corrected retry; a repeated identical
 * invalid call is flagged to the model instead of raising the limit.
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
export const MARKUP_ONLY_REPLY = "I could not complete that request. Please rephrase it.";

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
      return {
        status: "denied", tool: o.tool, rule: o.ruleId, reason: o.reason,
        ...(o.ruleId === "INVALID_ARGS" ? invalidArgsFeedback(o.tool, o.issues ?? []) : {}),
      };
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

  const allowed = new Set([...tools.map((t) => t.function.name), ...LOCAL_TOOL_NAMES]);
  const conversationInputs = () => `${[...input.history, userMsg].filter((m) => m.role === "user").map(textOf).join("\n")}\n${fetchedText}`;
  const invalidSeen = new Set<string>();

  for (let step = 1; step <= maxSteps; step++) {
    const reply = await deps.llm.complete(messages, tools);
    let calls = reply.tool_calls ?? [];
    let planText = reply.content ?? null;
    if (calls.length === 0) {
      const content = reply.content ?? "";
      const recovered = extractTextToolCalls(content, allowed, conversationInputs());
      if (recovered.calls.length === 0) {
        const clean = stripToolMarkup(content);
        const final = clean === "" && hasToolMarkup(content) ? MARKUP_ONLY_REPLY : clean;
        messages.push({ role: "assistant", content: final });
        return { reply: final, messages, outcomes, cards, steps: step, stoppedAtLimit: false };
      }
      // Text tool calls become real tool calls and take the same guard path; the markup is never shown.
      planText = recovered.rest || null;
      calls = recovered.calls.map((c, i) => ({ id: `text_${step}_${i + 1}`, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    }
    messages.push({ role: "assistant", content: planText, tool_calls: calls });
    for (const call of calls) {
      const { result, args } = await dispatch(deps, input.actor, input.conversationId, call.function.name, call.function.arguments, {
        trustedText, fetchedText, outcomes,
      });
      if (result.rule === "INVALID_ARGS") {
        const sig = `${call.function.name}:${JSON.stringify(args)}`;
        if (invalidSeen.has(sig)) result.repeated = "These exact arguments were already rejected. Fix them as described in issues, or stop and tell the user.";
        invalidSeen.add(sig);
      }
      if (!LOCAL_TOOL_NAMES.has(call.function.name)) {
        cards.push(buildPlanCard({ id: call.id, name: call.function.name, args }, planText, result, deps.store));
      }
      const content = JSON.stringify(result);
      if (result.status === "executed") fetchedText += `\n${content}`;
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  messages.push({ role: "assistant", content: STEP_LIMIT_REPLY });
  return { reply: STEP_LIMIT_REPLY, messages, outcomes, cards, steps: maxSteps, stoppedAtLimit: true };
}

async function dispatch(
  deps: AgentDeps,
  actor: Actor,
  conversationId: string | null,
  name: string,
  rawArgs: string,
  ctx: { trustedText: string; fetchedText: string; outcomes: GuardOutcome[] },
): Promise<{ result: Record<string, unknown>; args: Record<string, unknown> }> {
  const parsed = parseRawArgs(rawArgs);
  if (!parsed) {
    const result = {
      status: "denied", tool: name, rule: "INVALID_ARGS", reason: "Tool arguments must be a JSON object.",
      ...(TOOL_EXAMPLES[name] ? { example: TOOL_EXAMPLES[name] } : {}), hint: ARG_TYPE_HINT,
    };
    return { result, args: {} };
  }
  const { args, notes } = normalizeToolArgs(name, parsed);

  if (LOCAL_TOOL_NAMES.has(name)) {
    if (name === "explain_policy") return { result: { status: "executed", tool: name, data: policySummary(deps.policy) }, args };
    const row = deps.approvals.get(String(args.approval_id ?? ""));
    const result = row
      ? { status: "executed", tool: name, data: { approval_id: row.id, status: row.status, tool: row.tool, reason: row.reason } }
      : { status: "failed", tool: name, error: { code: "NOT_FOUND", message: "No approval with that id." } };
    return { result, args };
  }

  const provenance = deriveProvenance(name, args, {
    trustedText: ctx.trustedText,
    fetchedText: ctx.fetchedText,
    isKnownObject: (id) => deps.store.getObject(id) !== undefined,
    knownAmountsMinor: deps.store.knownAmountsMinor(),
  });
  const outcome = await deps.guard.handle({ actor, conversationId, tool: name, args, provenance, normalized: notes });
  ctx.outcomes.push(outcome);
  return { result: toModelResult(outcome), args };
}
