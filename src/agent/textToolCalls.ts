import { parseRawArgs } from "@/guard/argNormalize";

/**
 * Fallback for models that write tool calls as assistant TEXT instead of using the tool-calling
 * API (Qwen-style XML or JSON inside <tool_call>). Recovered calls go through exactly the same
 * guard, policy and approval path as real tool calls. Safety limits:
 * - only names from the allowed tool list are recovered; anything else is dropped;
 * - nothing is recovered when the conversation inputs (user text, tool results) already contain
 *   tool-call markup, so a pasted or fetched payload that the model echoes cannot become a call;
 * - at most MAX_TEXT_CALLS per message, bounded sizes.
 */

export type TextToolCall = { name: string; args: Record<string, unknown> };
export type TextToolCallResult = { calls: TextToolCall[]; rejected: string[]; rest: string };

export const MAX_TEXT_CALLS = 4;
const MAX_CONTENT = 20_000;
const MAX_PARAM = 10_000;

const XML_FUNCTION = /<function=([A-Za-z0-9_.-]{1,64})>([\s\S]*?)(?:<\/function>|$)/g;
const XML_PARAM = /<parameter=([A-Za-z0-9_.-]{1,64})>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;
const JSON_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const MARKUP = /<\/?tool_call>|<function=|<parameter=/i;

/** True when text contains anything that looks like tool-call markup. */
export function hasToolMarkup(text: string): boolean {
  return MARKUP.test(text);
}

function xmlParams(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const m of body.matchAll(XML_PARAM)) {
    const key = m[1]!;
    const value = m[2]!.replace(/^\n/, "").replace(/\n$/, "");
    if (value.length > MAX_PARAM || key === "__proto__" || key === "constructor" || key === "prototype") return null;
    // Values stay strings; argument normalization converts known structured/number params safely.
    args[key] = value.trim();
  }
  return args;
}

function jsonCall(raw: string): TextToolCall | null {
  const obj = parseRawArgs(raw);
  if (!obj || typeof obj.name !== "string") return null;
  const a = obj.arguments ?? obj.parameters ?? {};
  const args = typeof a === "string" ? parseRawArgs(a) : typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
  return args ? { name: obj.name, args } : null;
}

/** Extracts allowed tool calls written as text. `inputs` is the conversation input text (for echo detection). */
export function extractTextToolCalls(content: string, allowed: ReadonlySet<string>, inputs: string): TextToolCallResult {
  const empty = { calls: [], rejected: [], rest: content };
  if (!content || content.length > MAX_CONTENT || !hasToolMarkup(content)) return empty;
  const echoRisk = hasToolMarkup(inputs);
  const calls: TextToolCall[] = [];
  const rejected: string[] = [];
  const accept = (c: TextToolCall | null, label: string) => {
    if (!c) return void rejected.push(`${label}: unparseable`);
    if (echoRisk) return void rejected.push(`${c.name}: conversation inputs contain tool markup`);
    if (!allowed.has(c.name)) return void rejected.push(`${c.name}: not an allowed tool`);
    if (calls.length >= MAX_TEXT_CALLS) return void rejected.push(`${c.name}: too many calls`);
    calls.push(c);
  };
  let rest = content.replace(JSON_CALL, (_m, raw: string) => {
    accept(jsonCall(raw), "json");
    return " ";
  });
  rest = rest.replace(XML_FUNCTION, (_m, name: string, body: string) => {
    const args = xmlParams(body);
    accept(args ? { name, args } : null, name);
    return " ";
  });
  return { calls, rejected, rest: stripToolMarkup(rest) };
}

/** Removes leftover tool-call and thinking tags so they never reach the user. */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, " ")
    .replace(/<function=[^>]*>[\s\S]*?(?:<\/function>|$)/gi, " ")
    .replace(/<\/?(?:tool_call|function|parameter)(?:=[^>]*)?>/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
