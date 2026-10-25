import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { numberToMinor, parseMoneyToMinor } from "@/lib/money";
import { err, ok, type Result } from "@/lib/result";

/** Policy-as-code: YAML in major units on disk, integer minor units in memory. */

export const ROLES = ["clerk", "approver", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const DECISIONS = ["ALLOW", "REQUIRE_APPROVAL", "DENY"] as const;
export type DecisionKind = (typeof DECISIONS)[number];

const money = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const minor = typeof v === "number" ? numberToMinor(v) : parseMoneyToMinor(v);
  if (minor === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a non-negative amount with at most 2 decimals" });
    return z.NEVER;
  }
  return minor;
});

const WhenSchema = z
  .object({
    amount_gt: money.optional(),
    amount_lte: money.optional(),
    daily_refund_total_after_gt: money.optional(),
    order_created_by_payguard: z.boolean().optional(),
  })
  .strict();

const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, "rule ids are lowercase kebab-case"),
    tools: z.array(z.string().min(1)).min(1),
    roles: z.array(z.enum(ROLES)).min(1).optional(),
    when: WhenSchema.optional(),
    decision: z.enum(DECISIONS),
    reason: z.string().optional(),
  })
  .strict();

const PolicySchema = z
  .object({
    version: z.literal(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: z.string().refine(isValidTimeZone, "unknown IANA time zone"),
    approval_ttl_hours: z.number().int().positive().max(24 * 30),
    sensitive_tools: z.array(z.string().min(1)),
    limits: z.object({ daily_refund_cap: money, daily_capture_cap: money }).strict(),
    rules: z.array(RuleSchema).min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.rules.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules", i, "id"], message: `duplicate rule id "${r.id}"` });
      seen.add(r.id);
    });
  });

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRule = Policy["rules"][number];

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parsePolicy(yamlText: string): Result<Policy, string> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return err(`Policy YAML syntax error: ${(e as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    return err(`Invalid policy:\n${lines.join("\n")}`);
  }
  return ok(parsed.data);
}

/** Boot-time loader: an invalid policy must stop the app rather than fall back to something permissive. */
export function loadPolicyFile(path: string): Policy {
  const result = parsePolicy(readFileSync(path, "utf8"));
  if (!result.ok) throw new Error(`${path}: ${result.error}`);
  return result.value;
}
