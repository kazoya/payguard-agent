// Starts `next dev` in mock mode (in-memory DB, mock PayPal, offline demo LLM). Cross-platform, no credentials needed.
import { spawn } from "node:child_process";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { PAYPAL_ENV: "sandbox", ...process.env, PAYGUARD_MOCK: "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
