import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { approveApproval, rejectApproval } from "./api/approvals";
import { postChat } from "./api/chat";
import type { DisplayCard, DisplayMessage } from "./chatService";
import type { Runtime } from "./runtime";
import { userById, type DemoUser } from "./users";

/**
 * Demo history for mock mode. Each scripted turn runs through the same API functions the UI
 * calls (chat -> guard -> approvals), so the seeded audit chain is genuine and verifiable.
 */

export const DEFAULT_SEED_FILE = path.resolve(process.cwd(), "seed/demo.yaml");

const UserId = z.string().refine((id) => Boolean(userById(id)), "unknown demo user");
const SeedSchema = z.object({
  conversations: z.array(z.object({
    as: UserId,
    lang: z.enum(["en", "ar"]),
    turns: z.array(z.object({
      text: z.string().min(1).max(2000),
      expect: z.enum(["executed", "pending", "denied", "none"]),
      decide: z.object({
        as: UserId,
        action: z.enum(["approve", "reject"]),
        note: z.string().optional(),
        reason: z.string().optional(),
      }).optional(),
    })).min(1),
  })).min(1),
});
export type SeedScript = z.infer<typeof SeedSchema>;

export type SeedSummary = { turns: number; mismatches: string[]; approvals: Record<string, number>; auditRows: number };

export function loadSeedScript(file: string = DEFAULT_SEED_FILE): SeedScript {
  return SeedSchema.parse(parseYaml(readFileSync(file, "utf8")));
}

const statusOf = (card: DisplayCard | undefined): string =>
  !card ? "none" : card.status === "pending_approval" ? "pending" : card.status;

export async function seedDemo(rt: Runtime, script: SeedScript = loadSeedScript()): Promise<SeedSummary> {
  const mismatches: string[] = [];
  let turns = 0;
  for (const conv of script.conversations) {
    const user = userById(conv.as) as DemoUser;
    let conversationId: string | undefined;
    for (const turn of conv.turns) {
      turns += 1;
      const res = await postChat(rt, user, { text: turn.text, lang: conv.lang, ...(conversationId ? { conversationId } : {}) });
      if (res.status !== 200) { mismatches.push(`turn ${turns}: chat failed (${res.status})`); continue; }
      const body = res.body as { conversationId: string; messages: DisplayMessage[] };
      conversationId = body.conversationId;
      const card = body.messages.at(-1)?.cards.at(-1);
      const got = statusOf(card);
      if (got !== turn.expect) mismatches.push(`turn ${turns}: expected ${turn.expect}, got ${got}`);
      if (turn.decide && card?.approvalId) {
        const decider = userById(turn.decide.as) as DemoUser;
        const out = turn.decide.action === "approve"
          ? await approveApproval(rt, decider, card.approvalId, { note: turn.decide.note })
          : rejectApproval(rt, decider, card.approvalId, { reason: turn.decide.reason });
        if (out.status !== 200) mismatches.push(`turn ${turns}: ${turn.decide.action} failed (${out.status})`);
      }
    }
  }
  const rows = rt.db.prepare("SELECT status, COUNT(*) AS n FROM approvals GROUP BY status").all() as { status: string; n: number }[];
  const auditRows = (rt.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  return { turns, mismatches, approvals: Object.fromEntries(rows.map((r) => [r.status, r.n])), auditRows };
}
