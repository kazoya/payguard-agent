/**
 * Sandbox order smoke test: creates a $1.00 USD order through the PayGuard executor
 * (sandbox-forced toolkit, unique PayPal-Request-Id). Run: npm run smoke:order (reads .env).
 * Prints only the order id, status and the buyer approval link.
 */
import { loadEnv, requirePayPalCredentials } from "@/config/env";
import { createExecutor } from "@/guard/executor";
import { newId } from "@/lib/ids";
import { toolkitHandlerFactory } from "@/paypal/toolkit";

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const executor = createExecutor(toolkitHandlerFactory(requirePayPalCredentials(env)));
  const result = await executor.execute({
    tool: "create_order",
    args: { currencyCode: "USD", items: [{ name: "PayGuard smoke test", itemCost: 1, quantity: 1, taxPercent: 0, itemTotal: 1 }] },
    requestId: newId("smoke"),
  });
  if (!result.ok) {
    console.error(`create_order failed: code=${result.error.code} status=${result.error.status ?? "n/a"} message=${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  const data = result.value.data as { id?: string; status?: string; links?: { rel: string; href: string }[] };
  const approve = data.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  console.log(`order ok, id=${data.id ?? "?"}, status=${data.status ?? "?"}, approve=${approve ?? "n/a"}`);
}

main().catch((e: unknown) => {
  console.error(`smoke-order error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exitCode = 1;
});
