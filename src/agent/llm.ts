import OpenAI from "openai";
import type { ChatCompletionMessage, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

/** Minimal LLM port: one chat completion step with tools. Any OpenAI-compatible server works. */
export type Llm = {
  complete(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ChatCompletionMessage>;
};

export type LlmConfig = { baseURL: string; apiKey: string; model: string };

export function createOpenAiLlm(cfg: LlmConfig): Llm {
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return {
    async complete(messages, tools) {
      const res = await client.chat.completions.create({
        model: cfg.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0,
      });
      const msg = res.choices[0]?.message;
      if (!msg) throw new Error("LLM returned no choices");
      return msg;
    },
  };
}

/** Scripted LLM for tests: returns the queued messages in order and records what it was sent. */
export class MockLLM implements Llm {
  readonly received: ChatCompletionMessageParam[][] = [];
  private readonly script: ChatCompletionMessage[];

  constructor(script: ChatCompletionMessage[]) {
    this.script = [...script];
  }

  async complete(messages: ChatCompletionMessageParam[]): Promise<ChatCompletionMessage> {
    this.received.push(structuredClone(messages));
    const next = this.script.shift();
    if (!next) throw new Error("MockLLM script exhausted");
    return next;
  }

  static toolCall(id: string, name: string, args: Record<string, unknown>): ChatCompletionMessage {
    return {
      role: "assistant", content: null, refusal: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    };
  }

  static text(content: string): ChatCompletionMessage {
    return { role: "assistant", content, refusal: null };
  }
}
