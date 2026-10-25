import { describe, expect, it } from "vitest";
import ar from "@/i18n/ar.json";
import { errorText, reasonText } from "@/i18n/reasons";
import { loadPolicyFile } from "@/guard/policy";
import { DEFAULT_POLICY_FILE } from "@/server/runtime";

const AR = ar as Record<string, string>;

describe("reason and error code translations", () => {
  it("has an Arabic reason for every non-silent policy rule and built-in deny code", () => {
    const policy = loadPolicyFile(DEFAULT_POLICY_FILE);
    const ids = policy.rules.filter((r) => r.decision !== "ALLOW").map((r) => r.id);
    const builtIns = ["UNKNOWN_TOOL", "UNTRUSTED_SOURCE", "AMOUNT_REQUIRED", "INVALID_AMOUNT", "CURRENCY_NOT_ALLOWED", "REFUND_EXCEEDS_CAPTURE", "NO_MATCHING_RULE", "INVALID_ARGS"];
    for (const id of [...ids, ...builtIns]) expect(AR[`reason.${id}`], id).toBeTruthy();
  });

  it("keeps the policy file's English reason in English and swaps in the Arabic string in Arabic", () => {
    expect(reasonText("en", "refund-large", "From policy file")).toBe("From policy file");
    expect(reasonText("ar", "refund-large", "From policy file")).toBe(AR["reason.refund-large"]);
    expect(reasonText("ar", "custom-rule", "Custom reason")).toBe("Custom reason");
    expect(reasonText("ar", null, null)).toBeNull();
  });

  it("maps API error codes to localized text and leaves unknown codes to the caller", () => {
    expect(errorText("ar", "SELF_APPROVAL")).toBe(AR["errcode.SELF_APPROVAL"]);
    expect(errorText("en", "NOT_A_CODE")).toBeNull();
  });
});
