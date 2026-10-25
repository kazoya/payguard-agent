import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadScenarios, runScenario, type ScenarioResult } from "./runner";

/** `npm run eval`: runs every scenario offline, prints a table and writes a JSON report. */
async function main(): Promise<void> {
  const root = path.resolve(__dirname);
  const scenarios = loadScenarios(path.join(root, "scenarios"));
  const results: ScenarioResult[] = [];
  for (const { file, scenario } of scenarios) results.push(await runScenario(scenario, file));

  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
  console.log(`${pad("scenario", 34)} ${pad("tool", 16)} ${pad("decision", 17)} ${pad("rule", 22)} result`);
  for (const r of results) {
    const o = r.observed;
    console.log(`${pad(r.id, 34)} ${pad(o.tool ?? "-", 16)} ${pad(o.decision ?? "-", 17)} ${pad(o.ruleId ?? "-", 22)} ${r.pass ? "PASS" : "FAIL"}`);
    for (const f of r.failures) console.log(`    - ${f}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} scenarios passed (${Math.round((passed / Math.max(1, results.length)) * 100)}%)`);

  const dir = path.join(root, "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "latest.json");
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), llm: "demo", paypal: "mock", passed, total: results.length, results }, null, 2));
  console.log(`report: ${path.relative(process.cwd(), file)}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
