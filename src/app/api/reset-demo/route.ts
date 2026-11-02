import { clearStateCookies } from "@/server/visitorState";
import { isMockMode } from "@/config/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Resets the visitor's demo state by clearing state cookies.
 * Only works in mock mode.
 */
export function POST() {
  if (!isMockMode(process.env)) {
    return Response.json({ error: { code: "NOT_IN_MOCK_MODE", message: "Reset is only available in mock mode" } }, { status: 400 });
  }
  
  // Clear all visitor state cookies (up to 10 chunks should be enough)
  const cookies = clearStateCookies(10);
  
  const response = Response.json({ ok: true, message: "Demo state reset. Refresh the page to start fresh." });
  
  // Set all the clear cookies
  for (const cookie of cookies) {
    response.headers.append("Set-Cookie", cookie);
  }
  
  return response;
}
