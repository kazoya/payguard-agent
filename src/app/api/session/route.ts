import { readJson, toResponse } from "@/server/api/http";
import { postSession } from "@/server/api/session";
import { actorFromCookieHeader } from "@/server/users";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const r = postSession(actorFromCookieHeader(req.headers.get("cookie")), await readJson(req));
  const res = toResponse(r);
  for (const c of r.cookies) res.headers.append("set-cookie", c);
  return res;
}
