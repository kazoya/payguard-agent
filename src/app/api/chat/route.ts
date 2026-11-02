import { after } from "next/server";
import { getChat, postChatSettled, runningTurns } from "@/server/api/chat";
import { readJson } from "@/server/api/http";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return handle(req, (rt, user) => getChat(rt, user, new URL(req.url).searchParams.get("conversationId")));
}

export async function POST(req: Request) {
  const body = await readJson(req);
  return handle(req, async (rt, user) => {
    const res = await postChatSettled(rt, user, body);
    // Serverless hosts may freeze the function once the response is sent; keep it alive for the turn.
    after(() => runningTurns(rt));
    return res;
  });
}
