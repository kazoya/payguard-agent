import { describe, expect, it } from "vitest";
import { minorToDecimalString, numberToMinor, parseMoneyToMinor } from "@/lib/money";
import { canonicalJson, hashJson } from "@/lib/hash";
import { dayKey } from "@/lib/clock";

describe("money", () => {
  it.each([
    ["50", 5000], ["50.0", 5000], ["50.00", 5000], ["50.01", 5001], ["0.1", 10], ["1000.00", 100000], [" 7.5 ", 750],
  ])("parses %s -> %d", (input, minor) => expect(parseMoneyToMinor(input)).toBe(minor));

  it.each([["-1"], ["1.001"], ["1e3"], ["abc"], [""], ["1,000"], ["NaN"]])("rejects %s", (input) => {
    expect(parseMoneyToMinor(input)).toBeNull();
  });

  it("converts numbers without float drift", () => {
    expect(numberToMinor(19.99)).toBe(1999);
    expect(numberToMinor(0.1 + 0.2)).toBeNull(); // 0.30000000000000004 has too many decimals: reject, never round silently
    expect(numberToMinor(-5)).toBeNull();
    expect(numberToMinor(Number.NaN)).toBeNull();
  });

  it("formats minor units", () => {
    expect(minorToDecimalString(5001)).toBe("50.01");
    expect(minorToDecimalString(7)).toBe("0.07");
    expect(() => minorToDecimalString(1.5)).toThrow();
  });
});

describe("hash + clock helpers", () => {
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
    expect(hashJson({ x: 1, y: 2 })).toBe(hashJson({ y: 2, x: 1 }));
  });

  it("day keys follow the policy time zone (Amman midnight, not UTC)", () => {
    expect(dayKey(new Date("2026-10-24T20:59:00Z"), "Asia/Amman")).toBe("2026-10-24");
    expect(dayKey(new Date("2026-10-24T21:01:00Z"), "Asia/Amman")).toBe("2026-10-25");
  });
});
