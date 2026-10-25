import type { DisplayMessage } from "@/server/chatService";

/**
 * Browser side of the async chat API (see server/api/chat.ts). Framework-free so it is unit-tested.
 * Never trusts a response to be JSON: a proxy (e.g. a Cloudflare tunnel 524 page) or a cut
 * connection can return HTML or an empty body.
 */

export const POLL_INTERVAL_MS = 1500;
/** The client stops waiting after this long and tells the user to check the audit log. */
export const MAX_WAIT_MS = 15 * 60_000;

export type ActiveTurn = { turnId: string; startedAt: string };
export type ChatState = { conversationId: string | null; messages: DisplayMessage[]; activeTurn?: ActiveTurn | null };
export type TurnState = {
  turnId: string;
  conversationId: string;
  status: "pending" | "done" | "error";
  startedAt: string;
  error: { code: string } | null;
  messages: DisplayMessage[];
  stoppedAtLimit: boolean;
};

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isMessages = (v: unknown): v is DisplayMessage[] => Array.isArray(v);

/** Parses a response body as JSON; returns null for an empty or non-JSON body instead of throwing. */
export async function readJsonSafe(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function asChatState(v: unknown): ChatState | null {
  if (!isObj(v) || !isMessages(v.messages)) return null;
  if (v.conversationId !== null && typeof v.conversationId !== "string") return null;
  const a = v.activeTurn;
  const activeTurn = isObj(a) && typeof a.turnId === "string" && typeof a.startedAt === "string" ? { turnId: a.turnId, startedAt: a.startedAt } : null;
  return { conversationId: v.conversationId, messages: v.messages, activeTurn };
}

export function asTurnState(v: unknown): TurnState | null {
  if (!isObj(v) || typeof v.turnId !== "string" || typeof v.conversationId !== "string" || !isMessages(v.messages)) return null;
  if (v.status !== "pending" && v.status !== "done" && v.status !== "error") return null;
  return {
    turnId: v.turnId, conversationId: v.conversationId, status: v.status, startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
    error: isObj(v.error) && typeof v.error.code === "string" ? { code: v.error.code } : null,
    messages: v.messages, stoppedAtLimit: v.stoppedAtLimit === true,
  };
}

export async function fetchChat(fetchFn: FetchFn, conversationId: string | null): Promise<ChatState | null> {
  const q = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  try {
    const res = await fetchFn(`/api/chat${q}`, { cache: "no-store" });
    return res.ok ? asChatState(await readJsonSafe(res)) : null;
  } catch {
    return null;
  }
}

export type StartResult =
  | { kind: "started"; conversationId: string; turnId: string; messages: DisplayMessage[] }
  /** 409: a turn is already running in this conversation. */
  | { kind: "busy"; turnId: string | null }
  /** 4xx: the server refused the message; nothing ran. */
  | { kind: "rejected"; status: number }
  /** Network error, 5xx, proxy timeout or unreadable body: the turn may or may not have started. */
  | { kind: "unknown" };

export async function startTurn(fetchFn: FetchFn, body: { conversationId?: string; text: string; lang: string }): Promise<StartResult> {
  let res: Response;
  try {
    res = await fetchFn("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { kind: "unknown" };
  }
  const data = await readJsonSafe(res);
  if (res.status === 409) {
    const e = isObj(data) && isObj(data.error) ? data.error : {};
    return { kind: "busy", turnId: typeof e.turnId === "string" && e.turnId ? e.turnId : null };
  }
  if (res.ok && isObj(data) && typeof data.turnId === "string" && typeof data.conversationId === "string") {
    return { kind: "started", conversationId: data.conversationId, turnId: data.turnId, messages: isMessages(data.messages) ? data.messages : [] };
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 408) return { kind: "rejected", status: res.status };
  return { kind: "unknown" };
}

export type PollOutcome =
  | { kind: "done"; turn: TurnState }
  | { kind: "error"; turn: TurnState }
  /** 404: the turn is not visible to this user (e.g. the demo role was switched). */
  | { kind: "gone" }
  | { kind: "timeout" }
  | { kind: "aborted" };

export type PollOptions = {
  fetchFn: FetchFn;
  signal?: AbortSignal;
  intervalMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called after every poll: the latest pending state (or null if this poll failed) and the consecutive failure count. */
  onUpdate?: (turn: TurnState | null, failures: number) => void;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
  });

/** Polls GET /api/chat/turns/:id until the turn finishes. Transient failures (network, 5xx, 524, non-JSON) are retried. */
export async function pollTurn(turnId: string, opts: PollOptions): Promise<PollOutcome> {
  const { fetchFn, signal, intervalMs = POLL_INTERVAL_MS, maxWaitMs = MAX_WAIT_MS, now = Date.now, sleep = defaultSleep } = opts;
  const deadline = now() + maxWaitMs;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return { kind: "aborted" };
    let turn: TurnState | null = null;
    try {
      const res = await fetchFn(`/api/chat/turns/${encodeURIComponent(turnId)}`, { cache: "no-store", signal });
      if (res.status === 404) return { kind: "gone" };
      if (res.ok) turn = asTurnState(await readJsonSafe(res));
    } catch {
      turn = null;
    }
    if (signal?.aborted) return { kind: "aborted" };
    if (turn?.status === "done") return { kind: "done", turn };
    if (turn?.status === "error") return { kind: "error", turn };
    failures = turn ? 0 : failures + 1;
    opts.onUpdate?.(turn, failures);
    if (now() >= deadline) return { kind: "timeout" };
    await sleep(intervalMs, signal);
  }
}

/** Whole seconds since an ISO start time, never negative (client and server clocks can differ). */
export function elapsedSeconds(startedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}
