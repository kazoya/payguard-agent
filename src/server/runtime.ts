import path from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { DemoLLM } from "@/agent/demoLlm";
import { createOpenAiLlm, type Llm } from "@/agent/llm";
import { isMockMode, loadEnv, requireLlmConfig, requirePayPalCredentials, type Env } from "@/config/env";
import { DEFAULT_MIGRATIONS_DIR, openDb, type Db } from "@/db/db";
import { loadPolicyFile, type Policy } from "@/guard/policy";
import { systemClock, type Clock } from "@/lib/clock";
import { parseMoneyToMinor } from "@/lib/money";
import { MockPayPal } from "@/paypal/mockPayPal";
import { toolkitHandlerFactory } from "@/paypal/toolkit";
import { createPayGuard, type PayGuard } from "./container";
import { DEMO_USERS } from "./users";

/** Process-wide runtime: DB, safety layer, LLM and PayPal tools, built once per server process. */

export type Runtime = PayGuard & {
  db: Db;
  llm: Llm;
  paypalTools: ChatCompletionTool[];
  clock: Clock;
  mode: { paypal: "mock" | "sandbox"; llm: "demo" | "openai" };
  mockPayPal: MockPayPal | null;
  env: Env | null;
};

export const DEFAULT_POLICY_FILE = path.resolve(process.cwd(), "policies/default.policy.yaml");

/** Seed captures for the offline demo. Ids look like PayPal ids but exist only in MockPayPal. */
export const DEMO_CAPTURES = [
  { id: "8MC585209K746392H", amount: "45.00" },
  { id: "2GG279541U471931P", amount: "120.00" },
  { id: "9TW04187LK2930028", amount: "1500.00" },
  { id: "4KX31962MV6619203", amount: "64.90" },
  { id: "7NR50183HB2241519", amount: "249.00" },
] as const;

export function seedUsers(db: Db): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO users (id, display_name, role) VALUES (?, ?, ?)");
  for (const u of DEMO_USERS) stmt.run(u.id, u.name, u.role);
}

export function buildMockRuntime(opts: { clock?: Clock; policy?: Policy; migrationsDir?: string; captures?: readonly { id: string; amount: string }[] } = {}): Runtime {
  const clock = opts.clock ?? systemClock;
  const db = openDb(":memory:", opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const paypal = new MockPayPal(clock);
  const policy = opts.policy ?? loadPolicyFile(DEFAULT_POLICY_FILE);
  const pg = createPayGuard({ db, policy, handlerFactory: paypal.factory, clock });
  seedUsers(db);
  for (const c of opts.captures ?? DEMO_CAPTURES) {
    paypal.addCapture(c.id, c.amount);
    pg.store.upsertObject({
      id: c.id, kind: "capture", status: "COMPLETED", amount_minor: parseMoneyToMinor(c.amount), currency: "USD",
      created_by_payguard: 0, raw_json: null, updated_at: clock().toISOString(),
    });
  }
  return {
    ...pg, db, clock, llm: new DemoLLM(), paypalTools: paypal.handler().getTools(),
    mode: { paypal: "mock", llm: "demo" }, mockPayPal: paypal, env: null,
  };
}

export function buildSandboxRuntime(env: Env): Runtime {
  const db = openDb(path.resolve(process.cwd(), env.DATABASE_PATH));
  const factory = toolkitHandlerFactory(requirePayPalCredentials(env));
  const pg = createPayGuard({ db, policy: loadPolicyFile(DEFAULT_POLICY_FILE), handlerFactory: factory, clock: systemClock });
  seedUsers(db);
  const hasLlm = Boolean(env.LLM_BASE_URL && env.LLM_MODEL);
  return {
    ...pg, db, clock: systemClock,
    llm: hasLlm ? createOpenAiLlm(requireLlmConfig(env)) : new DemoLLM(),
    paypalTools: factory({}).getTools(),
    mode: { paypal: "sandbox", llm: hasLlm ? "openai" : "demo" }, mockPayPal: null, env,
  };
}

const KEY = Symbol.for("payguard.runtime");
type Holder = { [KEY]?: Runtime };

/** Lazily built singleton; kept on globalThis so Next dev hot reloads do not open a second DB. */
export function getRuntime(): Runtime {
  const g = globalThis as Holder;
  if (!g[KEY]) {
    const env = loadEnv();
    g[KEY] = isMockMode(env) ? buildMockRuntime() : buildSandboxRuntime(env);
  }
  return g[KEY]!;
}

const SEED_KEY = Symbol.for("payguard.seed");
type SeedHolder = { [SEED_KEY]?: Promise<unknown> };

/**
 * Like getRuntime(), but in mock mode waits for the demo history (seed/demo.yaml) to be loaded
 * once. Set PAYGUARD_SEED=0 to start with an empty mock database.
 */
export async function getReadyRuntime(): Promise<Runtime> {
  const rt = getRuntime();
  if (rt.mode.paypal !== "mock" || process.env.PAYGUARD_SEED === "0") return rt;
  const g = globalThis as SeedHolder;
  g[SEED_KEY] ??= import("./seed").then(({ seedDemo }) => seedDemo(rt)).catch((e: unknown) => {
    console.error("[payguard] demo seed failed:", e instanceof Error ? e.message : e);
  });
  await g[SEED_KEY];
  return rt;
}

/** Test hook: replace the singleton (e.g. with a mock runtime on a fake clock). */
export function setRuntimeForTests(rt: Runtime | undefined, seeded = true): void {
  (globalThis as Holder)[KEY] = rt;
  (globalThis as SeedHolder)[SEED_KEY] = seeded ? Promise.resolve() : undefined;
}
