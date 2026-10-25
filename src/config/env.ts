import { z } from "zod";

/**
 * Environment loader. PayGuard is SANDBOX ONLY: the PayPal Agent Toolkit defaults to live
 * (`context.sandbox ?? false`), so the app refuses to boot unless PAYPAL_ENV is exactly "sandbox".
 * Error messages never include values, because some keys are secrets.
 */

export const SANDBOX_ONLY_MESSAGE = "PayGuard runs in PayPal SANDBOX only (set PAYPAL_ENV=sandbox)";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_ENV: z.string(),
  PAYPAL_WEBHOOK_ID: optionalString,
  LLM_BASE_URL: optionalUrl,
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  LLM_EVAL_MODEL: optionalString,
  APP_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default("http://localhost:3000")),
  DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default("./data/payguard.db")),
  DEMO_DEFAULT_ROLE: z.preprocess(emptyToUndefined, z.enum(["clerk", "approver", "owner"]).default("clerk")),
  DEMO_ACCESS_PASSWORD: optionalString,
  /** "1"/"true": offline demo mode (in-memory DB, mock PayPal, deterministic demo LLM). No keys needed. */
  PAYGUARD_MOCK: z.preprocess(emptyToUndefined, z.enum(["0", "1", "true", "false"]).optional()),
});

export type Env = Readonly<z.infer<typeof EnvSchema> & { PAYPAL_ENV: "sandbox" }>;

export class EnvError extends Error {
  override name = "EnvError";
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source.PAYPAL_ENV !== "sandbox") throw new EnvError(SANDBOX_ONLY_MESSAGE);
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only key names and issue codes: zod issues can carry the received value.
    const keys = parsed.error.issues.map((i) => `${i.path.join(".")} (${i.code})`).join(", ");
    throw new EnvError(`Invalid environment: ${keys}`);
  }
  return Object.freeze({ ...parsed.data, PAYPAL_ENV: "sandbox" as const });
}

export function isMockMode(env: Pick<Env, "PAYGUARD_MOCK">): boolean {
  return env.PAYGUARD_MOCK === "1" || env.PAYGUARD_MOCK === "true";
}

export type PayPalCredentials = { clientId: string; clientSecret: string };

/** Credentials are optional at boot (UI, tests) but required before any PayPal call. */
export function requirePayPalCredentials(env: Env): PayPalCredentials {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new EnvError("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env (sandbox app credentials)");
  }
  return { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET };
}

export type LlmConfig = { baseURL: string; apiKey: string; model: string };

export function requireLlmConfig(env: Env): LlmConfig {
  if (!env.LLM_BASE_URL || !env.LLM_MODEL) {
    throw new EnvError("LLM_BASE_URL and LLM_MODEL must be set in .env");
  }
  // Local OpenAI-compatible servers (Ollama) accept any key; the client library requires a non-empty one.
  return { baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY ?? "not-needed", model: env.LLM_MODEL };
}
