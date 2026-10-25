import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarios, runScenario } from "../eval/runner";

describe("eval scenarios (offline, deterministic)", () => {
  const scenarios = loadScenarios(path.resolve(__dirname, "../eval/scenarios"));

  it("has at least 15 scenarios, including Arabic ones", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    expect(scenarios.some(({ scenario }) => /[\u0600-\u06FF]/.test(scenario.user))).toBe(true);
  });

  it.each(scenarios.map(({ file, scenario }) => [`${file}:${scenario.id}`, scenario] as const))("%s", async (_name, scenario) => {
    const r = await runScenario(scenario);
    expect(r.failures).toEqual([]);
  });
});
