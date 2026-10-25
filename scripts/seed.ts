import { buildMockRuntime } from "@/server/runtime";
import { seedDemo } from "@/server/seed";

/**
 * `npm run seed`: builds a fresh mock runtime (in-memory DB with the demo users, the default
 * policy and sandbox-style captures), replays seed/demo.yaml through the real chat and approval
 * path, and prints what was created. The dev server runs the same seed on start in mock mode.
 */
async function main(): Promise<void> {
  const rt = buildMockRuntime();
  const summary = await seedDemo(rt);
  const users = rt.db.prepare("SELECT id, display_name, role FROM users ORDER BY id").all();
  console.log("Demo users:", users);
  console.log(`Policy rules: ${rt.policy.rules.map((r) => r.id).join(", ")}`);
  console.log(`Scripted turns: ${summary.turns}`);
  console.log("Approvals by status:", summary.approvals);
  console.log(`Audit rows: ${summary.auditRows}; chain verified: ${rt.audit.verifyChain().ok}`);
  if (summary.mismatches.length) {
    console.error("Seed mismatches:\n" + summary.mismatches.join("\n"));
    process.exitCode = 1;
  }
}

void main();
