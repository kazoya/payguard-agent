import type { ChatCompletionMessageToolCall, ChatCompletionTool, ChatCompletionToolMessageParam } from "openai/resources";

/** The slice of PayPalAgentToolkit that PayGuard depends on; MockPayPal implements the same shape. */
export type ToolCallHandler = {
  getTools(): ChatCompletionTool[];
  handleToolCall(toolCall: ChatCompletionMessageToolCall): Promise<ChatCompletionToolMessageParam>;
};

/**
 * The toolkit only sends PayPal-Request-Id from its per-instance context, so the executor asks
 * for a fresh handler per action with that action's request id.
 */
export type ToolCallHandlerFactory = (opts: { requestId?: string }) => ToolCallHandler;
