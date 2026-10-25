import { describe, expect, it } from "vitest";
import { buildMockRuntime } from "@/server/runtime";
import { postChat } from "@/server/api/chat";
import { loadSeedScript, seedDemo } from "@/server/seed";
import { DEMO_USERS } from "@/server/users";

const fixedClock = () => new Date("2026-11-02T09:00:00Z");

describe("demo seed", () => {
  it("replays every scripted turn with the expected policy outcome and an intact audit chain", async () => {
    const rt = buildMockRuntime({ clock: fixedClock });
    const summary = await seedDemo(rt, loadSeedScript());
    expect(summary.mismatches).toEqual([]);
    expect(summary.approvals).toMatchObject({ EXECUTED: 1, REJECTED: 1, PENDING: 2 });
    expect(rt.audit.verifyChain().ok).toBe(true);
  });

  it("answers list questions with sandbox-shaped transactions and disputes", async () => {
    const rt = buildMockRuntime({ clock: fixedClock });
    await seedDemo(rt);
    const user = DEMO_USERS[0]!;
    const ask = async (text: string) => {
      const res = await postChat(rt, user, { text, lang: "en" });
      const body = res.body as { messages: { role: string; text: string }[] };
      return body.messages.at(-1)!.text;
    };
    const tx = await ask("List recent transactions");
    expect(tx).toContain("8MC585209K746392H · T0006 · 45.00 USD");
    expect(tx).toMatch(/T1107 · -15\.00 USD/);
    expect(await ask("Show open disputes")).toContain("PP-D-27803 · MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
  });
});
