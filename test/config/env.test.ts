import { describe, expect, it } from "vitest";
import { EnvError, loadEnv, requireLlmConfig, requirePayPalCredentials, SANDBOX_ONLY_MESSAGE } from "@/config/env";

const FAKE_SECRET = "FAKE-test-secret-value-1234567890";
const base = { PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "fake-client-id", PAYPAL_CLIENT_SECRET: FAKE_SECRET };

describe("loadEnv", () => {
  it("accepts sandbox and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.PAYPAL_ENV).toBe("sandbox");
    expect(env.DATABASE_PATH).toBe("./data/payguard.db");
    expect(env.DEMO_DEFAULT_ROLE).toBe("clerk");
    expect(Object.isFrozen(env)).toBe(true);
  });

  it.each([["live"], ["production"], ["SANDBOX"], [""], [undefined]])("refuses PAYPAL_ENV=%s", (value) => {
    expect(() => loadEnv({ ...base, PAYPAL_ENV: value })).toThrow(SANDBOX_ONLY_MESSAGE);
  });

  it("treats empty strings from .env.example as unset", () => {
    const env = loadEnv({ PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", LLM_BASE_URL: "" });
    expect(env.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(env.LLM_BASE_URL).toBeUndefined();
  });

  it("never puts a secret value into an error message", () => {
    for (const bad of [{ ...base, PAYPAL_ENV: "live" }, { ...base, LLM_BASE_URL: FAKE_SECRET }, { ...base, DEMO_DEFAULT_ROLE: FAKE_SECRET }]) {
      try {
        loadEnv(bad);
        expect.unreachable("should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        expect((e as Error).message).not.toContain(FAKE_SECRET);
      }
    }
  });

  it("requires PayPal credentials only when a PayPal call is about to happen", () => {
    const env = loadEnv({ PAYPAL_ENV: "sandbox" });
    expect(() => requirePayPalCredentials(env)).toThrow(/PAYPAL_CLIENT_ID/);
    expect(requirePayPalCredentials(loadEnv(base)).clientId).toBe("fake-client-id");
  });

  it("builds LLM config with a placeholder key for local servers", () => {
    const env = loadEnv({ ...base, LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "qwen2.5" });
    expect(requireLlmConfig(env)).toEqual({ baseURL: "http://localhost:11434/v1", apiKey: "not-needed", model: "qwen2.5" });
    expect(() => requireLlmConfig(loadEnv(base))).toThrow(/LLM_BASE_URL/);
  });
});
