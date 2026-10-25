import { NextResponse } from "next/server";
import { isMockMode, loadEnv } from "@/config/env";

export const dynamic = "force-dynamic";

/** Reports only non-secret status, so it is safe to expose in the demo. */
export function GET() {
  try {
    const env = loadEnv();
    return NextResponse.json({ ok: true, paypalEnv: env.PAYPAL_ENV, paypalConfigured: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
      mode: isMockMode(env) ? "mock" : "sandbox",
      llm: env.LLM_BASE_URL && env.LLM_MODEL ? "openai-compatible" : "demo",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
