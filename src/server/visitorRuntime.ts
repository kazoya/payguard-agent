import { openDb, DEFAULT_MIGRATIONS_DIR, type Db } from "@/db/db";
import { parseMoneyToMinor } from "@/lib/money";
import { insertDemoBaseline } from "./demoBaseline";
import { applyDelta, decodeDelta, encodeDeltaWithinBudget, exportDelta, isEmptyDelta } from "./visitorDelta";
import { buildMockRuntime, seedUsers, DEMO_CAPTURES, type Runtime } from "./runtime";
import {
  extractStateCookies,
  formatStateCookies,
  getStateKey,
  verifyStateSignature,
  type VisitorDelta,
} from "./visitorState";

/**
 * Per-visitor runtime for mock mode on serverless. The static demo baseline is loaded from code
 * on every request. Cookies hold only the visitor's delta (decisions on seeded ids + their own rows).
 */

const stateKey = getStateKey();

function readDelta(cookieHeader: string | null): VisitorDelta | null {
  const { chunks, signature } = extractStateCookies(cookieHeader);
  if (chunks.length === 0 || !signature) return null;
  if (!verifyStateSignature(chunks, signature, stateKey)) {
    console.warn("[payguard] Visitor state signature invalid, starting fresh");
    return null;
  }
  try {
    return decodeDelta(chunks);
  } catch (err) {
    console.warn("[payguard] Failed to decode visitor delta, starting fresh:", err);
    return null;
  }
}

function upsertDemoCaptures(db: Db, updatedAt: string): void {
  const stmt = db.prepare(
    `INSERT INTO paypal_objects (id, kind, status, amount_minor, currency, created_by_payguard, raw_json, updated_at)
     VALUES (?, 'capture', 'COMPLETED', ?, 'USD', 0, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const c of DEMO_CAPTURES) {
    stmt.run(c.id, parseMoneyToMinor(c.amount), updatedAt);
  }
}

/** Replay executed refunds onto MockPayPal so remaining-capture checks match the DB. */
function applyRefundedAmounts(rt: Runtime): void {
  const rows = rt.db.prepare(
    "SELECT target_id, amount_minor FROM executions WHERE tool = 'create_refund' AND status = 'EXECUTED' AND target_id IS NOT NULL",
  ).all() as { target_id: string; amount_minor: number | null }[];
  for (const r of rows) {
    if (r.amount_minor != null) rt.mockPayPal?.noteRefunded(r.target_id, r.amount_minor);
  }
}

export async function getVisitorRuntime(cookieHeader: string | null): Promise<{ runtime: Runtime; saveState: () => string[] }> {
  const delta = readDelta(cookieHeader);
  const db = openDb(":memory:", DEFAULT_MIGRATIONS_DIR);
  seedUsers(db);
  insertDemoBaseline(db);
  if (delta) applyDelta(db, delta);
  upsertDemoCaptures(db, new Date().toISOString());

  const runtime = buildMockRuntime({ db });
  applyRefundedAmounts(runtime);

  const saveState = (): string[] => {
    const next = exportDelta(db);
    if (isEmptyDelta(next)) return [];
    return formatStateCookies(encodeDeltaWithinBudget(next), stateKey);
  };

  return { runtime, saveState };
}

export function hasVisitorState(cookieHeader: string | null): boolean {
  const { chunks } = extractStateCookies(cookieHeader);
  return chunks.length > 0;
}
