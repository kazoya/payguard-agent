// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "@/components/ChatView";
import type { DisplayMessage } from "@/server/chatService";

const user = (text: string): DisplayMessage => ({ id: "m1", role: "user", text, cards: [], notice: null, createdAt: "2026-10-25T10:00:00.000Z" });
const agent = (text: string): DisplayMessage => ({ id: "m2", role: "assistant", text, cards: [], notice: null, createdAt: "2026-10-25T10:00:00.000Z" });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

async function send(text: string) {
  fireEvent.change(screen.getByTestId("chat-input"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await flush();
}

describe("<ChatView> async turns", () => {
  it("shows a thinking indicator with elapsed seconds while polling, then renders the reply", async () => {
    let polls = 0;
    handler = (url, init) => {
      if (init?.method === "POST") return json(202, { conversationId: "conv_1", turnId: "turn_1", status: "pending", messages: [user("Explain the policy")] });
      if (url.startsWith("/api/chat/turns/turn_1")) {
        polls += 1;
        const done = polls >= 3;
        return json(200, { turnId: "turn_1", conversationId: "conv_1", status: done ? "done" : "pending", startedAt: "", error: null,
          messages: done ? [user("Explain the policy"), agent("Refunds over $100 need a manager.")] : [user("Explain the policy")], stoppedAtLimit: false });
      }
      return json(200, { conversationId: null, messages: [], activeTurn: null });
    };
    render(<ChatView userId="u_clerk" />);
    await flush();
    await send("Explain the policy");

    expect(screen.getByTestId("chat-thinking").textContent).toMatch(/Checking… 0s/);
    expect(screen.getByText("Explain the policy")).toBeTruthy();
    await flush(1600);
    expect(screen.getByTestId("chat-thinking").textContent).toMatch(/Checking… 1s/);
    await flush(1600);
    expect(screen.queryByTestId("chat-thinking")).toBeNull();
    expect(screen.getByText("Refunds over $100 need a manager.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("on a failed turn says actions may have run and links the audit log", async () => {
    handler = (url, init) => {
      if (init?.method === "POST") return json(202, { conversationId: "conv_1", turnId: "turn_1", status: "pending", messages: [user("x")] });
      if (url.startsWith("/api/chat/turns/")) return json(200, { turnId: "turn_1", conversationId: "conv_1", status: "error", startedAt: "", error: { code: "AGENT_FAILED" }, messages: [user("x")], stoppedAtLimit: false });
      return json(200, { conversationId: null, messages: [], activeTurn: null });
    };
    render(<ChatView userId="u_clerk" />);
    await flush();
    await send("x");
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/may already have run/);
    expect(alert.querySelector('a[href="/audit"]')).toBeTruthy();
    expect(alert.textContent).not.toMatch(/Nothing was executed/);
  });

  it("does not crash on a non-JSON proxy response and resumes the turn found on reload", async () => {
    let started = false;
    handler = (url, init) => {
      if (init?.method === "POST") { started = true; return new Response("<html>524</html>", { status: 524 }); }
      if (url.startsWith("/api/chat/turns/turn_7")) return json(200, { turnId: "turn_7", conversationId: "conv_1", status: "pending", startedAt: new Date().toISOString(), error: null, messages: [user("y")], stoppedAtLimit: false });
      // Before the POST there is no conversation; afterwards the server has one with the turn in flight.
      return json(200, started
        ? { conversationId: "conv_1", messages: [user("y")], activeTurn: { turnId: "turn_7", startedAt: new Date().toISOString() } }
        : { conversationId: null, messages: [], activeTurn: null });
    };
    render(<ChatView userId="u_clerk" />);
    await flush();
    await send("y");
    await flush();
    expect(screen.getByTestId("chat-thinking")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resumes polling an in-flight turn after a page reload", async () => {
    handler = (url) => {
      if (url.startsWith("/api/chat/turns/turn_5")) return json(200, { turnId: "turn_5", conversationId: "conv_1", status: "done", startedAt: "", error: null, messages: [user("z"), agent("Answer after reload")], stoppedAtLimit: false });
      return json(200, { conversationId: "conv_1", messages: [user("z")], activeTurn: { turnId: "turn_5", startedAt: new Date().toISOString() } });
    };
    render(<ChatView userId="u_clerk" />);
    await flush();
    await flush();
    expect(screen.getByText("Answer after reload")).toBeTruthy();
  });
});
