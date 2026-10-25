import { describe, expect, it } from "vitest";
import { asTurnState, elapsedSeconds, pollTurn, readJsonSafe, startTurn, type TurnState } from "@/components/chatClient";

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const htmlRes = (status: number) => new Response("<html><body>Error 524: A timeout occurred</body></html>", { status, headers: { "content-type": "text/html" } });
const turn = (status: TurnState["status"], extra: Partial<TurnState> = {}): TurnState => ({
  turnId: "turn_1", conversationId: "conv_1", status, startedAt: "2026-10-25T10:00:00.000Z", error: null, messages: [], stoppedAtLimit: false, ...extra,
});
const noSleep = async () => {};

describe("readJsonSafe", () => {
  it("parses JSON and returns null for empty, cut or HTML bodies instead of throwing", async () => {
    expect(await readJsonSafe(jsonRes(200, { a: 1 }))).toEqual({ a: 1 });
    expect(await readJsonSafe(new Response(""))).toBeNull();
    expect(await readJsonSafe(new Response('{"conversationId":"c'))).toBeNull(); // "Unexpected end of JSON input"
    expect(await readJsonSafe(htmlRes(524))).toBeNull();
  });
});

describe("startTurn", () => {
  const body = { text: "Refund $20", lang: "en" };
  it("returns the turn on 202", async () => {
    const r = await startTurn(async () => jsonRes(202, { conversationId: "conv_1", turnId: "turn_1", status: "pending", messages: [] }), body);
    expect(r).toEqual({ kind: "started", conversationId: "conv_1", turnId: "turn_1", messages: [] });
  });

  it("maps 409 to busy with the running turn id", async () => {
    const r = await startTurn(async () => jsonRes(409, { error: { code: "TURN_IN_PROGRESS", message: "x", turnId: "turn_9" } }), body);
    expect(r).toEqual({ kind: "busy", turnId: "turn_9" });
  });

  it("maps 400/404 to rejected (nothing ran)", async () => {
    expect(await startTurn(async () => jsonRes(400, { error: { code: "INVALID_INPUT" } }), body)).toEqual({ kind: "rejected", status: 400 });
    expect(await startTurn(async () => jsonRes(404, { error: { code: "NOT_FOUND" } }), body)).toEqual({ kind: "rejected", status: 404 });
  });

  it("treats network errors, 5xx, a proxy 524 page and an unreadable 202 as unknown (the turn may have started)", async () => {
    expect(await startTurn(async () => { throw new TypeError("Failed to fetch"); }, body)).toEqual({ kind: "unknown" });
    expect(await startTurn(async () => htmlRes(524), body)).toEqual({ kind: "unknown" });
    expect(await startTurn(async () => jsonRes(500, { error: { code: "INTERNAL" } }), body)).toEqual({ kind: "unknown" });
    expect(await startTurn(async () => new Response("", { status: 202 }), body)).toEqual({ kind: "unknown" });
  });
});

describe("pollTurn", () => {
  function scripted(responses: (Response | Error)[]) {
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      const next = responses.shift() ?? jsonRes(200, turn("pending"));
      if (next instanceof Error) throw next;
      return next;
    };
    return { fetchFn, urls };
  }

  it("polls the turn URL until done and reports pending updates", async () => {
    const { fetchFn, urls } = scripted([jsonRes(200, turn("pending")), jsonRes(200, turn("pending")), jsonRes(200, turn("done", { stoppedAtLimit: true }))]);
    const updates: (string | null)[] = [];
    const out = await pollTurn("turn_1", { fetchFn, sleep: noSleep, onUpdate: (t) => updates.push(t?.status ?? null) });
    expect(out).toMatchObject({ kind: "done", turn: { status: "done", stoppedAtLimit: true } });
    expect(updates).toEqual(["pending", "pending"]);
    expect(urls).toEqual(Array(3).fill("/api/chat/turns/turn_1"));
  });

  it("keeps polling through transient failures (network, 524 HTML, cut JSON) and counts them", async () => {
    const { fetchFn } = scripted([new TypeError("Failed to fetch"), htmlRes(524), new Response('{"turnId":', { status: 200 }), jsonRes(200, turn("pending")), jsonRes(200, turn("done"))]);
    const failures: number[] = [];
    const out = await pollTurn("turn_1", { fetchFn, sleep: noSleep, onUpdate: (_t, f) => failures.push(f) });
    expect(out.kind).toBe("done");
    expect(failures).toEqual([1, 2, 3, 0]);
  });

  it("returns error with the turn, gone on 404, timeout after the deadline, aborted when cancelled", async () => {
    expect(await pollTurn("turn_1", { fetchFn: scripted([jsonRes(200, turn("error", { error: { code: "AGENT_FAILED" } }))]).fetchFn, sleep: noSleep }))
      .toMatchObject({ kind: "error", turn: { error: { code: "AGENT_FAILED" } } });
    expect(await pollTurn("turn_1", { fetchFn: scripted([jsonRes(404, { error: { code: "NOT_FOUND" } })]).fetchFn, sleep: noSleep })).toEqual({ kind: "gone" });

    let t = 0;
    const out = await pollTurn("turn_1", { fetchFn: scripted([]).fetchFn, sleep: async (ms) => { t += ms; }, now: () => t, intervalMs: 1000, maxWaitMs: 5000 });
    expect(out).toEqual({ kind: "timeout" });
    expect(t).toBe(5000);

    const ac = new AbortController();
    const aborted = pollTurn("turn_1", { fetchFn: scripted([]).fetchFn, signal: ac.signal, sleep: async () => { ac.abort(); } });
    expect(await aborted).toEqual({ kind: "aborted" });
  });
});

describe("helpers", () => {
  it("validates turn payloads and clamps elapsed seconds", () => {
    expect(asTurnState({ ...turn("done"), extra: 1 })).toMatchObject({ status: "done" });
    expect(asTurnState({ ...turn("done"), status: "weird" })).toBeNull();
    expect(asTurnState("<html>")).toBeNull();
    expect(elapsedSeconds(1000, 13_999)).toBe(12);
    expect(elapsedSeconds(5000, 1000)).toBe(0);
  });
});
