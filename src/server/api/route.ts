import { getReadyRuntime, type Runtime } from "../runtime";
import { actorFromCookieHeader, type DemoUser } from "../users";
import { apiError, toResponse, type ApiResponse } from "./http";
import { getVisitorRuntime } from "../visitorRuntime";
import { isMockMode } from "@/config/env";

/** Shared wrapper for Next route handlers: resolves runtime + demo user, never leaks internals. */
export async function handle(req: Request, fn: (rt: Runtime, user: DemoUser) => ApiResponse | Promise<ApiResponse>): Promise<Response> {
  try {
    const cookieHeader = req.headers.get("cookie");
    const inMockMode = isMockMode(process.env);
    
    let rt: Runtime;
    let saveState: (() => string[]) | null = null;
    
    if (inMockMode) {
      // Use per-visitor runtime in mock mode
      const visitor = await getVisitorRuntime(cookieHeader);
      rt = visitor.runtime;
      saveState = visitor.saveState;
    } else {
      // Use shared runtime in sandbox mode
      rt = await getReadyRuntime();
    }
    
    const fallback = rt.env?.DEMO_DEFAULT_ROLE ?? "clerk";
    const user = actorFromCookieHeader(cookieHeader, fallback);
    const response = await fn(rt, user);
    
    // In mock mode, save visitor state to cookies
    if (inMockMode && saveState) {
      const stateCookies = saveState();
      const existingCookies = response.cookies ?? [];
      return toResponse({ ...response, cookies: [...existingCookies, ...stateCookies] });
    }
    
    return toResponse(response);
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    console.error("[payguard] request failed:", name, e instanceof Error ? e.message : "");
    return toResponse(apiError(500, "INTERNAL", name === "EnvError" && e instanceof Error ? e.message : "Internal error"));
  }
}
