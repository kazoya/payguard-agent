import { getChat, postChat } from "@/server/api/chat";
import { readJson } from "@/server/api/http";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return handle(req, (rt, user) => getChat(rt, user, new URL(req.url).searchParams.get("conversationId")));
}

export async function POST(req: Request) {
  const body = await readJson(req);
  return handle(req, (rt, user) => postChat(rt, user, body));
}
