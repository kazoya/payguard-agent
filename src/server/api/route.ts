import { getReadyRuntime, type Runtime } from "../runtime";
import { actorFromCookieHeader, type DemoUser } from "../users";
import { apiError, toResponse, type ApiResponse } from "./http";

/** Shared wrapper for Next route handlers: resolves runtime + demo user, never leaks internals. */
export async function handle(req: Request, fn: (rt: Runtime, user: DemoUser) => ApiResponse | Promise<ApiResponse>): Promise<Response> {
  try {
    const rt = await getReadyRuntime();
    const fallback = rt.env?.DEMO_DEFAULT_ROLE ?? "clerk";
    const user = actorFromCookieHeader(req.headers.get("cookie"), fallback);
    return toResponse(await fn(rt, user));
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    console.error("[payguard] request failed:", name, e instanceof Error ? e.message : "");
    return toResponse(apiError(500, "INTERNAL", name === "EnvError" && e instanceof Error ? e.message : "Internal error"));
  }
}
