import { createHmac, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";

/**
 * Per-visitor state for mock mode on serverless. Since serverless instances don't share memory,
 * we store a visitor's mock state (approvals, audit log, etc.) in signed cookies. The state is
 * small enough to fit in cookies when gzipped and split across multiple cookies.
 * 
 * Security: HMAC-SHA256 signature prevents tampering. The state key is derived from env or
 * generated per process (ephemeral, which means restarts lose state, but that's OK for demo).
 */

const MAX_COOKIE_SIZE = 3800; // Leave margin under 4 KB
const COOKIE_PREFIX = "pg_vs_"; // visitor state
const SIG_COOKIE = "pg_vs_sig";

export type StateKey = Buffer;

/**
 * Visitor state schema: minimal representation of DB state needed for mock demo.
 */
const ApprovalStateSchema = z.object({
  id: z.string(),
  conversation_id: z.string().nullable(),
  requested_by: z.string(),
  tool: z.string(),
  args_json: z.string(),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  policy_rule: z.string(),
  reason: z.string().nullable(),
  status: z.enum(["PENDING", "APPROVED", "EXECUTED", "REJECTED", "FAILED", "EXPIRED"]),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  decision_note: z.string().nullable(),
  result_json: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});

const AuditStateSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  actor: z.string(),
  event: z.string(),
  tool: z.string().nullable(),
  decision: z.string().nullable(),
  approval_id: z.string().nullable(),
  input_hash: z.string().nullable(),
  output_hash: z.string().nullable(),
  detail_json: z.string().nullable(),
  prev_hash: z.string(),
  hash: z.string(),
});

const ExecutionStateSchema = z.object({
  id: z.string(),
  approval_id: z.string().nullable(),
  requested_by: z.string(),
  tool: z.string(),
  target_id: z.string().nullable(),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.enum(["EXECUTED", "FAILED"]),
  day_key: z.string(),
  created_at: z.string(),
});

const PayPalObjectStateSchema = z.object({
  id: z.string(),
  kind: z.enum(["order", "capture", "refund"]),
  status: z.string().nullable(),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  created_by_payguard: z.number(),
  raw_json: z.string().nullable(),
  updated_at: z.string(),
});

const ConversationStateSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  created_at: z.string(),
  lang: z.string().nullable(),
});

const MessageStateSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.string(),
  content: z.string(),
  provenance: z.string(),
  created_at: z.string(),
});

const ChatTurnStateSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  status: z.enum(["pending", "done", "error"]),
  stopped_at_limit: z.number(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export const VisitorStateSchema = z.object({
  version: z.literal(1),
  approvals: z.array(ApprovalStateSchema),
  audit: z.array(AuditStateSchema),
  executions: z.array(ExecutionStateSchema),
  paypal_objects: z.array(PayPalObjectStateSchema),
  conversations: z.array(ConversationStateSchema),
  messages: z.array(MessageStateSchema),
  chat_turns: z.array(ChatTurnStateSchema),
});

export type VisitorState = z.infer<typeof VisitorStateSchema>;

/**
 * Derives a 32-byte key from environment or generates ephemeral key per process.
 */
export function getStateKey(): StateKey {
  const env = process.env.PAYGUARD_STATE_KEY;
  if (env) {
    const buf = Buffer.from(env, "hex");
    if (buf.length !== 32) throw new Error("PAYGUARD_STATE_KEY must be 32 bytes (64 hex chars)");
    return buf;
  }
  // Ephemeral: state survives only within this process
  return randomBytes(32);
}

/**
 * Serializes state to compressed base64 chunks.
 */
export function encodeState(state: VisitorState): string[] {
  const json = JSON.stringify(state);
  const compressed = gzipSync(json);
  const b64 = compressed.toString("base64");
  
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += MAX_COOKIE_SIZE) {
    chunks.push(b64.slice(i, i + MAX_COOKIE_SIZE));
  }
  return chunks;
}

/**
 * Reconstructs state from chunks. Throws on invalid format.
 */
export function decodeState(chunks: string[]): VisitorState {
  const b64 = chunks.join("");
  const compressed = Buffer.from(b64, "base64");
  const json = gunzipSync(compressed).toString("utf8");
  const data = JSON.parse(json);
  return VisitorStateSchema.parse(data);
}

/**
 * Computes HMAC-SHA256 signature of the state.
 */
export function signState(chunks: string[], key: StateKey): string {
  const data = chunks.join("");
  return createHmac("sha256", key).update(data).digest("hex");
}

/**
 * Verifies state signature.
 */
export function verifyStateSignature(chunks: string[], signature: string, key: StateKey): boolean {
  const expected = signState(chunks, key);
  return signature === expected;
}

/**
 * Extracts visitor state cookie chunks from headers.
 */
export function extractStateCookies(cookieHeader: string | null): { chunks: string[]; signature: string | null } {
  if (!cookieHeader) return { chunks: [], signature: null };
  
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k, v.join("=")];
    })
  );

  const chunks: string[] = [];
  for (let i = 0; ; i++) {
    const val = cookies[`${COOKIE_PREFIX}${i}`];
    if (!val) break;
    chunks.push(decodeURIComponent(val));
  }
  
  const signature = cookies[SIG_COOKIE] ? decodeURIComponent(cookies[SIG_COOKIE]) : null;
  return { chunks, signature };
}

/**
 * Formats state as Set-Cookie headers.
 */
export function formatStateCookies(chunks: string[], key: StateKey): string[] {
  const sig = signState(chunks, key);
  const cookies = chunks.map((chunk, i) =>
    `${COOKIE_PREFIX}${i}=${encodeURIComponent(chunk)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
  cookies.push(`${SIG_COOKIE}=${encodeURIComponent(sig)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return cookies;
}

/**
 * Clears all visitor state cookies.
 */
export function clearStateCookies(count: number): string[] {
  const cookies: string[] = [];
  for (let i = 0; i < count; i++) {
    cookies.push(`${COOKIE_PREFIX}${i}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  cookies.push(`${SIG_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return cookies;
}

/**
 * Creates empty initial state.
 */
export function createEmptyState(): VisitorState {
  return {
    version: 1,
    approvals: [],
    audit: [],
    executions: [],
    paypal_objects: [],
    conversations: [],
    messages: [],
    chat_turns: [],
  };
}
