import { describe, expect, it } from "vitest";
import { 
  createEmptyState, 
  encodeState, 
  decodeState, 
  signState, 
  verifyStateSignature, 
  getStateKey,
  extractStateCookies,
  formatStateCookies 
} from "@/server/visitorState";
import { exportState, importState } from "@/server/stateSync";
import { openDb } from "@/db/db";
import { buildMockRuntime } from "@/server/runtime";

describe("visitor state serialization", () => {
  it("encodes and decodes empty state", () => {
    const state = createEmptyState();
    const chunks = encodeState(state);
    expect(chunks.length).toBeGreaterThan(0);
    const decoded = decodeState(chunks);
    expect(decoded).toEqual(state);
  });

  it("signs and verifies state", () => {
    const state = createEmptyState();
    const chunks = encodeState(state);
    const key = getStateKey();
    const sig = signState(chunks, key);
    expect(verifyStateSignature(chunks, sig, key)).toBe(true);
    expect(verifyStateSignature(chunks, "wrong", key)).toBe(false);
  });

  it("extracts state from cookie header", () => {
    const chunks = ["chunk0", "chunk1"];
    const key = getStateKey();
    const cookies = formatStateCookies(chunks, key);
    const header = cookies.map(c => c.split(";")[0]).join("; ");
    const extracted = extractStateCookies(header);
    expect(extracted.chunks).toEqual(chunks);
    expect(extracted.signature).toBeTruthy();
  });

  it("exports and imports database state", () => {
    const rt = buildMockRuntime();
    
    // Add some data
    rt.approvals.enqueue({
      requestedBy: "u_clerk",
      conversationId: "conv1",
      tool: "create_refund",
      args: { capture_id: "cap1", amount: { value: "50.00" } },
      amountMinor: 5000,
      currency: "USD",
      ruleId: "test-rule",
      reason: "test reason"
    });
    
    // Export state
    const state = exportState(rt.db);
    expect(state.approvals.length).toBe(1);
    expect(state.approvals[0].tool).toBe("create_refund");
    
    // Import into fresh database
    const db2 = openDb(":memory:");
    importState(db2, state);
    
    // Verify import
    const imported = db2.prepare("SELECT * FROM approvals").all();
    expect(imported.length).toBe(1);
    expect((imported[0] as any).tool).toBe("create_refund");
    
    db2.close();
  });

  it("preserves approval state across instances", () => {
    // Simulate instance 1: create pending approval
    const rt1 = buildMockRuntime();
    const approval = rt1.approvals.enqueue({
      requestedBy: "u_clerk",
      conversationId: "conv1",
      tool: "create_refund",
      args: { capture_id: "8MC585209K746392H", amount: { value: "70.00" } },
      amountMinor: 7000,
      currency: "USD",
      ruleId: "refund-large",
      reason: "Exceeds auto-refund limit"
    });
    
    // Export and encode state
    const state1 = exportState(rt1.db);
    const chunks = encodeState(state1);
    
    // Simulate instance 2: restore from cookies
    const state2 = decodeState(chunks);
    const db2 = openDb(":memory:");
    const rt2 = buildMockRuntime({ db: db2 });
    importState(db2, state2);
    
    // Verify approval exists in instance 2
    const found = rt2.approvals.get(approval.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("PENDING");
    expect(found?.tool).toBe("create_refund");
    expect(found?.amount_minor).toBe(7000);
    
    db2.close();
  });

  it("preserves audit chain across instances", () => {
    const rt1 = buildMockRuntime();
    
    // Generate some audit events
    rt1.audit.append({ actor: "u_clerk", event: "TEST_EVENT", tool: "test_tool" });
    rt1.audit.append({ actor: "u_manager", event: "TEST_EVENT_2", tool: "test_tool" });
    
    // Export and encode
    const state1 = exportState(rt1.db);
    const chunks = encodeState(state1);
    
    // Restore in instance 2
    const state2 = decodeState(chunks);
    const db2 = openDb(":memory:");
    importState(db2, state2);
    
    // Verify audit chain
    const audit = db2.prepare("SELECT * FROM audit_log ORDER BY seq").all() as any[];
    expect(audit.length).toBe(2);
    expect(audit[0].event).toBe("TEST_EVENT");
    expect(audit[1].event).toBe("TEST_EVENT_2");
    
    db2.close();
  });
});

describe("cross-instance approval workflow", () => {
  it("creates approval on instance 1 and approves on instance 2", async () => {
    // Instance 1: clerk creates large refund (goes to approval)
    const rt1 = buildMockRuntime();
    const approval = rt1.approvals.enqueue({
      requestedBy: "u_clerk",
      conversationId: "conv1",
      tool: "create_refund",
      args: { capture_id: "8MC585209K746392H", amount: { currency_code: "USD", value: "70.00" } },
      amountMinor: 7000,
      currency: "USD",
      ruleId: "refund-large",
      reason: "Exceeds auto-refund limit"
    });
    
    expect(approval.status).toBe("PENDING");
    
    // Serialize state
    const state1 = exportState(rt1.db);
    const chunks = encodeState(state1);
    
    // Instance 2: manager approves
    const state2 = decodeState(chunks);
    const db2 = openDb(":memory:");
    importState(db2, state2);
    const rt2 = buildMockRuntime({ db: db2 });
    
    const result = await rt2.approvals.approve(approval.id, { id: "u_manager", role: "approver" }, "Approved in test");
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("EXECUTED");
    }
    
    db2.close();
  });

  it("simulates fresh module state between requests (smoke test scenario)", async () => {
    // Request 1: Create large refund approval
    const rt1 = buildMockRuntime();
    const approval = rt1.approvals.enqueue({
      requestedBy: "u_clerk",
      conversationId: "conv1",
      tool: "create_refund",
      args: { capture_id: "8MC585209K746392H", amount: { currency_code: "USD", value: "70.00" } },
      amountMinor: 7000,
      currency: "USD",
      ruleId: "refund-large",
      reason: "Exceeds auto-refund limit"
    });
    
    const cookies1 = encodeState(exportState(rt1.db));
    
    // Request 2: Different instance, list approvals
    const db2 = openDb(":memory:");
    importState(db2, decodeState(cookies1));
    const rt2 = buildMockRuntime({ db: db2 });
    
    const list = rt2.approvals.list("PENDING");
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(approval.id);
    
    const cookies2 = encodeState(exportState(rt2.db));
    
    // Request 3: Another instance, approve
    const db3 = openDb(":memory:");
    importState(db3, decodeState(cookies2));
    const rt3 = buildMockRuntime({ db: db3 });
    
    const result = await rt3.approvals.approve(approval.id, { id: "u_manager", role: "approver" });
    expect(result.ok).toBe(true);
    
    const cookies3 = encodeState(exportState(rt3.db));
    
    // Request 4: Verify execution in yet another instance
    const db4 = openDb(":memory:");
    importState(db4, decodeState(cookies3));
    const rt4 = buildMockRuntime({ db: db4 });
    
    const final = rt4.approvals.get(approval.id);
    expect(final?.status).toBe("EXECUTED");
    
    db2.close();
    db3.close();
    db4.close();
  });
});
