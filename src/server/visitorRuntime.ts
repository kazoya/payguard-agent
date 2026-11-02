import { openDb, DEFAULT_MIGRATIONS_DIR } from "@/db/db";
import { buildMockRuntime, seedUsers, DEMO_CAPTURES } from "./runtime";
import { 
  extractStateCookies, 
  decodeState, 
  encodeState, 
  verifyStateSignature, 
  getStateKey, 
  formatStateCookies,
  type VisitorState 
} from "./visitorState";
import { exportState, importState } from "./stateSync";
import type { Runtime } from "./runtime";
import { parseMoneyToMinor } from "@/lib/money";

/**
 * Per-visitor runtime for mock mode on serverless. Each visitor gets their own isolated
 * database state, stored in signed cookies between requests.
 */

const stateKey = getStateKey();

/**
 * Creates a runtime from visitor cookies. If no valid state exists, creates a fresh seeded runtime.
 */
export async function getVisitorRuntime(cookieHeader: string | null): Promise<{ runtime: Runtime; saveState: () => string[] }> {
  const { chunks, signature } = extractStateCookies(cookieHeader);
  
  let state: VisitorState | null = null;
  
  // Try to restore from cookies
  if (chunks.length > 0 && signature) {
    if (verifyStateSignature(chunks, signature, stateKey)) {
      try {
        state = decodeState(chunks);
      } catch (err) {
        console.warn("[payguard] Failed to decode visitor state, starting fresh:", err);
        state = null;
      }
    } else {
      console.warn("[payguard] Visitor state signature invalid, starting fresh");
      state = null;
    }
  }

  // Create database and runtime
  const db = openDb(":memory:", DEFAULT_MIGRATIONS_DIR);
  
  // Always seed users first (they're referenced by foreign keys)
  seedUsers(db);
  
  if (state) {
    // Restore state from cookies
    importState(db, state);
  } else {
    // Fresh visitor: just add the demo captures (no conversation history)
    // This keeps the state small enough to fit in cookies
    const mockRuntime = buildMockRuntime({ db });
    for (const c of DEMO_CAPTURES) {
      mockRuntime.mockPayPal!.addCapture(c.id, c.amount);
      mockRuntime.store.upsertObject({
        id: c.id,
        kind: "capture",
        status: "COMPLETED",
        amount_minor: parseMoneyToMinor(c.amount),
        currency: "USD",
        created_by_payguard: 0,
        raw_json: null,
        updated_at: mockRuntime.clock().toISOString(),
      });
    }
  }

  const runtime = buildMockRuntime({ db });

  // Return runtime with save function
  const saveState = (): string[] => {
    const newState = exportState(db);
    const chunks = encodeState(newState);
    return formatStateCookies(chunks, stateKey);
  };

  return { runtime, saveState };
}

/**
 * Checks if request has visitor state cookies.
 */
export function hasVisitorState(cookieHeader: string | null): boolean {
  const { chunks } = extractStateCookies(cookieHeader);
  return chunks.length > 0;
}
