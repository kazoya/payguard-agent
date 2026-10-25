import { describe, expect, it } from "vitest";
import { exportAudit, listAudit, verifyAudit } from "@/server/api/audit";
import { postChat } from "@/server/api/chat";
import { postSession } from "@/server/api/session";
import { actorFromCookieHeader } from "@/server/users";
import { INJECTION, lina, mockRuntime, SMALL } from "./helpers";

describe("audit API", () => {
  it("lists newest first, verifies the chain and exports JSON/CSV", async () => {
    const { rt } = mockRuntime();
    await postChat(rt, lina, { text: SMALL });
    await postChat(rt, lina, { text: INJECTION });
    const list = listAudit(rt, null).body as { total: number; rows: { seq: number; event: string }[] };
    expect(list.total).toBeGreaterThanOrEqual(2);
    expect(list.rows[0]!.seq).toBeGreaterThan(list.rows.at(-1)!.seq);
    expect(list.rows.some((r) => r.event === "DENIED")).toBe(true);
    expect((listAudit(rt, "1").body as { rows: unknown[] }).rows).toHaveLength(1);
    expect(listAudit(rt, "0").status).toBe(400);

    expect(verifyAudit(rt).body).toMatchObject({ ok: true });

    const csv = exportAudit(rt, "csv");
    expect(csv.headers?.["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers?.["content-disposition"]).toMatch(/payguard-audit-2026-10-24\.csv/);
    expect(String(csv.body).split("\n")[0]).toMatch(/^seq,/);
    expect(JSON.parse(String(exportAudit(rt, null).body))).toHaveLength(list.total);
    expect(exportAudit(rt, "xml").status).toBe(400);
  });

  it("detects tampering through the verify endpoint", async () => {
    const { rt } = mockRuntime();
    await postChat(rt, lina, { text: SMALL });
    expect(() => rt.db.prepare("UPDATE audit_log SET actor = 'x' WHERE seq = 1").run()).toThrow(/append-only/);
    rt.db.exec("DROP TRIGGER audit_log_no_update"); // simulate an attacker with raw DB access
    rt.db.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 1").run();
    expect(verifyAudit(rt).body).toMatchObject({ ok: false });
  });
});

describe("session API", () => {
  it("switches demo user and language via cookies, rejecting unknown users", () => {
    const res = postSession(lina, { userId: "u_manager", lang: "ar" });
    expect(res.status).toBe(200);
    expect(res.cookies).toEqual([
      expect.stringMatching(/^pg_user=u_manager; Path=\/; SameSite=Lax/),
      expect.stringMatching(/^pg_lang=ar;/),
    ]);
    expect(postSession(lina, { userId: "u_root" }).status).toBe(400);
    expect(postSession(lina, { lang: "fr" }).status).toBe(400);
  });

  it("resolves the actor from the cookie header and falls back to the default user", () => {
    expect(actorFromCookieHeader("a=1; pg_user=u_owner").id).toBe("u_owner");
    expect(actorFromCookieHeader("pg_user=u_root").id).toBe("u_clerk");
    expect(actorFromCookieHeader(null).id).toBe("u_clerk");
  });
});
