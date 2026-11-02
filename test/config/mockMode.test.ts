import { describe, expect, it } from "vitest";
import { isMockMode, loadEnv } from "@/config/env";

const keys = { PAYPAL_CLIENT_ID: "fake-client-id", PAYPAL_CLIENT_SECRET: "FAKE-test-secret" };

describe("isMockMode", () => {
  it("is on when forced, even with keys", () => {
    expect(isMockMode({ ...keys, PAYGUARD_MOCK: "1" })).toBe(true);
    expect(isMockMode({ ...keys, PAYGUARD_MOCK: "true" })).toBe(true);
  });

  it("is off when explicitly disabled, even without keys (sandbox then requires keys)", () => {
    expect(isMockMode({ PAYGUARD_MOCK: "0" })).toBe(false);
    expect(isMockMode({ PAYGUARD_MOCK: "false" })).toBe(false);
  });

  it("falls back to the simulated demo when PayPal sandbox keys are absent", () => {
    expect(isMockMode({})).toBe(true);
    expect(isMockMode({ PAYGUARD_MOCK: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" })).toBe(true);
    expect(isMockMode({ PAYPAL_CLIENT_ID: "fake-client-id" })).toBe(true);
    expect(isMockMode({ PAYPAL_CLIENT_SECRET: "   " , PAYPAL_CLIENT_ID: "x"})).toBe(true);
  });

  it("uses the sandbox when both keys are present and mock is not forced", () => {
    expect(isMockMode(keys)).toBe(false);
    expect(isMockMode(loadEnv({ PAYPAL_ENV: "sandbox", ...keys }))).toBe(false);
  });

  it("works on a loaded env from an empty .env.example", () => {
    expect(isMockMode(loadEnv({ PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYGUARD_MOCK: "" }))).toBe(true);
  });
});
