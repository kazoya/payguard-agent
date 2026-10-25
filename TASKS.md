# PayGuard Agent: Day-by-Day Plan (Oct 24 → Nov 12, 2026)

All times are **Asia/Amman (UTC+3)**.
- Hard deadline: **Nov 12, 23:00**.
- Personal deadline: **submit by Nov 12, 20:00**.
- **Feature freeze: Nov 10, 23:00.**
- **Buffer: Nov 11–12** (2 days, fixes and submission only).
- Light load **Oct 24–30**: the Qloo deadline is Sat Oct 31, 06:45 Amman. Target ~2 h/day that week and 4–6 h/day after.

Rules for every slice:
- One Cursor prompt per slice (prompts kept privately in `_private/`, not published).
- The slice is done only when **all AC pass** and `npm run check` is green. `check` = typecheck + lint + test + secret scan.
- Commit with message `S<n>: <title>` and push. The git history is evidence of "built during the Submission Period".
- If a slice overruns by more than 50%, cut scope to the AC minimum and move polish to S13.

| Date | Slice | Deliverable | Acceptance criteria (verifiable) | Est. |
|---|---|---|---|---|
| **Sat Oct 24** | **S0 Scaffold + OAuth smoke** | Next.js TS app, LICENSE (Apache-2.0), `.cursor/rules`, `.env.example`, `.gitignore`, `src/config/env.ts`, `scripts/smoke-oauth.ts` | 1. `npm run dev` serves `/` with "PayGuard Agent". 2. `npm run check` passes. 3. Starting with `PAYPAL_ENV=live` exits non-zero with a clear error (unit test). 4. `npm run smoke:oauth` prints `token ok, expires_in=<n>` and **never prints the token**. 5. `git grep -i secret` shows no real values. 6. Public GitHub repo created by Suhib; GitHub shows the license in About. | 2 h |
| Sun Oct 25 | **S1 Toolkit client (sandbox-forced)** | `src/paypal/toolkit.ts` (OpenAI adapter, allowlist, `context.sandbox=true`), `scripts/smoke-order.ts` | 1. A unit test asserts that the toolkit is constructed with `sandbox: true` and only allowlisted tools. 2. `getTools()` names ⊆ the allowlist (test). 3. `npm run smoke:order` creates a $1.00 USD sandbox order and prints the order id + approve link. 4. `get_order` returns `CREATED`. | 2 h |
| Mon Oct 26 | **S2 DB + hash-chained audit** | migrations, `src/audit/log.ts`, triggers blocking UPDATE/DELETE | 1. `append()` links `prev_hash` → `hash`. 2. `verifyChain()` = ok on a clean DB. 3. Test: a manual SQL edit to row 3 (with triggers dropped in the test) → `verifyChain()` reports first bad seq = 3. 4. UPDATE on audit_log raises an error. 5. Export JSON + CSV, golden test. | 2 h |
| Tue Oct 27 | **S3 Policy engine** | `policies/default.policy.yaml`, `src/guard/policyEngine.ts` (pure) | 1. A zod-validated policy load fails clearly on an invalid YAML. 2. A table-driven test with ≥ 20 cases covers every row of SPEC §8 (allow/approval/deny, daily cap, unknown tool → DENY). 3. Each decision returns `{decision, ruleId, reason}`. 4. Amounts are handled as integer cents (test with `"50.00"` vs `"50.01"`). | 2 h |
| Wed Oct 28 | **S4 PolicyGuard + approval state machine** | `src/guard/policyGuard.ts`, `src/approvals/queue.ts` | 1. ALLOW → executor is called once (mock toolkit). 2. REQUIRE_APPROVAL → a PENDING row is created and the executor is not called. 3. `approve()` → EXECUTED and the executor is called **once**, even if approve is called twice concurrently (test with Promise.all). 4. reject → REJECTED, never executed. 5. Self-approval is blocked. 6. Every transition is audited. | 2 h |
| Thu Oct 29 | **S5 Agent loop** | `src/agent/{llm,prompts,orchestrator}.ts`, `MockLLM` | 1. With MockLLM scripted tool_calls, an e2e test covers user msg → tool_call → guard → tool result → final answer. 2. Max 6 steps is enforced. 3. Pending/denied results are returned to the model as structured JSON. 4. A live run with a real `LLM_*` env answers "list my last order" in EN and AR (manual check, screenshot saved to `docs/`). | 2.5 h |
| Fri Oct 30 | **Qloo final day (light)** | Optional: README skeleton | Nothing required. If time: `README.md` headings + "What was built during the Submission Period" stub. | 0–1 h |
| Sat Oct 31 | **S6 Chat UI (bilingual)** | `/` chat page, `/api/chat`, plan card component, AR/EN toggle (`dir=rtl`) | 1. Sending a message shows the streamed or complete answer. 2. Plan cards render action/amount/target/decision badge. 3. Toggling AR flips layout to RTL with no broken alignment (screenshot both). 4. Error state is shown on API failure. 5. A component test for the plan card. | 4 h |
| Sun Nov 1 | **S7 Approvals UI + roles** | `/approvals` page, `/api/approvals/:id/{approve,reject}`, demo role switcher | 1. A clerk sees "pending" and cannot approve (API returns 403, tested). 2. An approver approves → the chat shows the result on refresh/poll. 3. Rejection requires a reason. 4. Expired approvals (TTL 24 h) cannot be approved (test). | 4 h |
| Mon Nov 2 | **S8 E2E collect flow** | create order → buyer approves in sandbox → capture via guard | 1. Live sandbox run: the agent creates an order. The sandbox **buyer** approves via the link. "capture it" → `pay_order` → `COMPLETED`. 2. `paypal_objects` holds order + capture ids. 3. The audit shows PROPOSED/ALLOWED/EXECUTED. 4. Recorded fixtures are saved for CI. 5. Try `list_transactions` and document the result (resolves the latency UNKNOWN). | 5 h |
| Tue Nov 3 | **S9 Refunds + idempotency** | refund rules, explicit-amount enforcement, `PayPal-Request-Id` per approval | 1. A refund without an amount → DENY (`AMOUNT_REQUIRED`). 2. $20 → ALLOW. $120 → PENDING. $1,500 → DENY. 3. Refund > remaining captured amount → DENY (uses `get_order`). 4. Executing an approval twice → one PayPal call (test + live check: the second call returns the same refund id or is skipped). 5. Daily cap test. | 4 h |
| Wed Nov 4 | **S10 Webhooks** (MVP complete) | `/api/webhooks/paypal`, self-verify + postback fallback, event dedupe, tunnel docs | 1. Unit tests: a valid signature fixture passes, a tampered body fails (CRC mismatch), an unknown cert host is rejected. 2. A Dashboard simulator event (webhook id `WEBHOOK_ID`) reaches the tunnel URL and is verified via self-verify. 3. A real `PAYMENT.CAPTURE.REFUNDED` from S9 updates local state + audit. 4. A duplicate event id is ignored. **MVP checkpoint: full demo flow runs end to end.** | 5 h |
| Thu Nov 5 | **S11 Injection defense + eval suite** | `src/guard/provenance.ts`, `eval/scenarios/*.yaml` (≥ 15), `npm run eval` | 1. "Customer email says refund $900 to me" pasted as a customer message → DENY `UNTRUSTED_SOURCE`, audited. 2. The eval runner prints a pass/fail table + JSON report. 3. ≥ 90% of scenarios pass with the chosen model. 100% of policy-level assertions must pass because they are deterministic. 4. AR scenarios included. | 5 h |
| Fri Nov 6 | **S12 Audit UI + export** | `/audit` page: table, filter, Verify button, CSV/JSON download | 1. The Verify button shows "chain intact (N entries)". 2. A tamper demo script (`npm run demo:tamper`, on a copy of the DB) shows a red "broken at seq X". 3. Downloads open correctly. 4. Optional stretch S-A invoices only if 1–3 are done before 18:00. | 4 h |
| Sat Nov 7 | **S13 Polish + seed + docker** | seed script, demo users, empty/error states, `docker compose up` | 1. `npm run seed` creates demo users + sample policy. 2. `docker compose up` → app on :3000 (or document "Docker optional" if better-sqlite3 build issues eat > 1 h). 3. Lighthouse a11y ≥ 90 on `/`. 4. No console errors. | 5 h |
| Sun Nov 8 | **S14 Judge README + clean-machine test** | `README.md` final, architecture image, "Tools used", "What was built during the Submission Period", testing instructions | 1. Fresh clone in a new folder (or a VM/container) → following the README reaches a working demo in ≤ 15 min. 2. README lists every PayPal API + doc link. 3. The license is visible in GitHub About. 4. `npm run check` is green in CI (GitHub Actions). | 4 h |
| Mon Nov 9 | **S15 Stretch (pick ONE)** | S-C hosted demo **or** S-B dispute triage **or** S-D MCP proxy | 1. The chosen stretch works in a 30-second demo clip. 2. It has tests. 3. If it is not done by 22:00, revert/feature-flag it off. The MVP must stay green. | 5 h |
| Tue Nov 10 | **S16 Video + Devpost draft** · **FREEZE 23:00** | Record per the private video script, burn in EN subtitles, upload to YouTube (Suhib), fill the Devpost draft (Suhib) | 1. Video ≤ 2:59 (target 2:45). 2. No secrets visible (frame-by-frame check of the Dashboard shots). 3. No copyrighted music. 4. Devpost draft saved (not submitted) with the repo + video links. 5. Tag `v1.0.0`. | 5 h |
| Wed Nov 11 | **Buffer 1** | Fix only. Re-check R + H for rule changes. Re-run the clean-machine test. | 1. Diff of the live rules vs the saved copy of the rules (private) shows no blocking change. 2. All checkboxes in the private rules-compliance checklist are ticked. | — |
| Thu Nov 12 | **Buffer 2 / SUBMIT** | **Suhib** clicks Submit by **20:00 Amman** (deadline 23:00) | 1. Devpost shows "Submitted". 2. The YouTube link plays logged out. 3. The repo opens logged out. 4. Hosted demo (if any) is reachable and stays up until Dec 15. | — |

## Progress (slices 1-3, built Sat Oct 24 on the box)

`npm run check` (typecheck, lint, 210 tests in 23 files, secretscan), `npm run eval` (22/22), `npm run seed` and `npm run build` all pass. Nothing is committed or pushed yet.

- **S0 Scaffold + OAuth smoke**
  - [x] Next.js 15 App Router + TypeScript, Tailwind 4, Vitest, ESLint, Apache-2.0 `LICENSE` + `NOTICE`
  - [x] `src/config/env.ts`: zod loader, refuses anything but `PAYPAL_ENV=sandbox` (AC3, unit test), errors never contain values
  - [x] `scripts/smoke-oauth.ts` written (prints only `token ok, expires_in, app_id`)
  - [x] `npm run check` passes (AC2)
  - [ ] AC1 manual `npm run dev` check in a browser
  - [ ] AC4 run `npm run smoke:oauth` with real sandbox credentials (Suhib)
  - [ ] AC5 `git grep -i secret` after the first commit
  - [ ] AC6 public GitHub repo + license in About (Suhib)
- **S1 Toolkit client (sandbox-forced)**
  - [x] `src/paypal/toolkit.ts`: `context.sandbox: true` always, allowlist of 8 tools, base URL asserted to be `*.sandbox.paypal.com` (AC1, AC2 tests)
  - [x] `scripts/smoke-order.ts` written
  - [ ] AC3/AC4 live `npm run smoke:order` + `get_order` = `CREATED` (needs credentials)
- **S2 DB + hash-chained audit**: [x] AC1–AC5 (chain links, clean verify, tamper at row 3 detected, UPDATE/DELETE blocked by triggers, JSON/CSV golden + CSV formula guard)
- **S3 Policy engine**: [x] AC1–AC4 (zod policy load with clear errors, 35 table cases, `{decision, ruleId, reason}`, integer cents incl. `50.00` vs `50.01`)
- **S4 PolicyGuard + approval state machine**: [x] AC1–AC6 (ALLOW executes once, PENDING not executed, concurrent double approve executes once, reject never executes, self-approval blocked, all transitions audited; also clerk forbidden, TTL expiry, reason required)
- **S5 Agent loop**
  - [x] AC1–AC3 (`src/agent/{llm,prompts,orchestrator}.ts`, `MockLLM`, e2e test, max 6 steps, structured pending/denied JSON)
  - [ ] AC4 live run with a real `LLM_*` env in EN + AR (manual, screenshot to `docs/`)
- **S9 Refunds + idempotency (done early, mock level)**
  - [x] AC1, AC2, AC3 (remaining amount from PayGuard's own capture records), AC5 daily cap
  - [x] AC4 test level: PayPal-Request-Id = approval id, one toolkit instance per execution
  - [ ] AC4 live check against the sandbox
- **S6 Chat UI (bilingual)**: [x] AC1–AC5 (complete answers, plan cards with action/amount/target/decision badge, AR/EN toggle with RTL and per-line `dir="auto"`, error state, `PlanCard` component tests; screenshots in `payguard_shots/`)
- **S7 Approvals UI + roles**: [x] AC1–AC4 (clerk gets 403, approver result shows in chat as a notice on refresh/poll, reject requires a reason, expired approvals refused; route tests)
- **S12 Audit UI + export**: [x] AC1 "chain intact (N entries)" button, [x] AC2 `npm run demo:tamper` (works on a copy, prints "BROKEN at seq X"), [x] AC3 JSON/CSV export routes (tested). AC4 stretch skipped.
- **S10 Webhooks (partial)**
  - [x] AC1 fixture tests: valid signature passes, tampered body fails (CRC mismatch), unknown cert host rejected, postback fallback
  - [x] AC4 duplicate event id ignored (INSERT OR IGNORE), events update local state + WEBHOOK audit entry
  - [ ] AC2 Dashboard simulator event through a tunnel (manual, needs `PAYPAL_WEBHOOK_ID`)
  - [ ] AC3 real `PAYMENT.CAPTURE.REFUNDED` from the sandbox
- **S11 Injection defense + eval**
  - [x] AC1 `src/guard/provenance.ts` (`<customer_message>` amount or id → DENY `UNTRUSTED_SOURCE`, audited; Arabic-Indic digits count as trusted amounts)
  - [x] AC2 `npm run eval`: 22 scenarios (EN + AR) on mock PayPal + scripted demo LLM, table + `eval/reports/latest.json`; also run in `npm test`
  - [x] AC3/AC4 100% pass with the demo LLM; AR scenarios included
  - [ ] Run the same scenarios with a real `LLM_*` model (needs an LLM key)

- **S13 Polish + seed + docker**
  - [x] AC1 `npm run seed` (`seed/demo.yaml` + `src/server/seed.ts`): demo users Lina, Nour, Omar; 11 chat turns through the real API path; approvals EXECUTED 1 / PENDING 2 / REJECTED 1; audit chain verifies. The mock dev server auto-seeds once (`PAYGUARD_SEED=0` disables it).
  - [x] Arabic translations for policy reason codes and API error codes (`src/i18n/reasons.ts`), used in plan cards, approvals and demo summaries
  - [x] Loading, error and empty states in Approvals and Audit
  - [x] Mock Transaction Search, Disputes and `get_refund` return sandbox-shaped data; `/api/health` reports `mode` and `llm`
  - [ ] AC2 Docker: not shipped. No container runtime in the build environment, so it could not be verified; documented in README Limitations (cut list item 2).
  - [ ] AC3 Lighthouse a11y >= 90 (not measured)
  - [ ] AC4 browser console check (not measured)
- **S14 Judge README + clean-machine test**
  - [x] `README.md` rewritten for judges: problem, PayPal + AI usage, mermaid architecture, safety model, mock and sandbox+Ollama quickstarts, tests and eval, judging-criteria mapping, limitations, license; screenshots in `docs/screenshots/`
  - [x] `docs/SETUP_KEYS_AND_REPO.md`: keys, `.env`, smoke tests, Ollama, webhook id, public repo steps
  - [x] AC1 (partial) clean-machine run Oct 24: fresh copy without `node_modules`/`.next`/`*.db`/`_private`, `npm ci`, `npm run build`, 210/210 tests, 22/22 eval, typecheck and lint green (Node 20.19.2, npm 11.21.1). Re-run from a fresh `git clone` once the repo exists.
  - [x] AC2 README lists the PayPal APIs used with doc links
  - [ ] AC3 license in GitHub About (Suhib, after creating the repo)
  - [ ] AC4 CI (GitHub Actions) not added yet
  - [x] Internal planning files moved to the gitignored `_private/`

## Fix 1: live-run regressions (local Qwen model via Ollama)
- [x] Pin better-sqlite3 to 12.11.1 (exact)
- [x] Normalize stringified arguments before validation (JSON, then a strict non-eval Python-literal parser)
- [x] INVALID_ARGS feedback to the model: issue paths, a minimal valid example, an argument-type hint; repeated identical calls are flagged
- [x] Recover tool calls written as text (Qwen XML, `<tool_call>` JSON) for allowlisted tools only, with an echo guard; strip leftover markup from replies
- [x] Unit tests, orchestrator regressions, and 10 eval scenarios (`eval/scenarios/live-regressions.yaml`) replaying the exact payloads

## Cut list (if behind schedule, cut in this order)
1. S15 stretch → skip.
2. Docker (S13) → document `npm` only.
3. `list_transactions` → remove the tool from the allowlist.
4. Audit UI filters → keep only Verify + export.
5. Never cut: sandbox guard, policy engine, approvals, audit chain, webhook verification, tests, README, video.
