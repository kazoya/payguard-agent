import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import agentAr from "@/i18n/agent.ar.json";
import agentEn from "@/i18n/agent.en.json";
import ar from "@/i18n/ar.json";
import en from "@/i18n/en.json";
import { dirOf, translate } from "@/i18n";
import { ROOT } from "./helpers/setup";

const ARABIC = /[\u0600-\u06FF]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("i18n", () => {
  it("has the same keys in English and Arabic dictionaries", () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(agentAr).sort()).toEqual(Object.keys(agentEn).sort());
  });

  it("interpolates variables and sets direction", () => {
    expect(translate("en", "chat.title")).toBe(en["chat.title"]);
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
  });

  it("keeps Arabic text out of code: only src/i18n/*.json may contain it", () => {
    const offenders = files(path.join(ROOT, "src"))
      .filter((f) => !f.includes(`${path.sep}i18n${path.sep}`) || !f.endsWith(".json"))
      .filter((f) => ARABIC.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
