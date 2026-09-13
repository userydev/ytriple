import type { Model, ResponseStreamEvent } from "@openai/agents";

/**
 * Buffered transports return a complete provider response. Agents SDK 0.18's
 * Chat Completions stream accumulator drops tool-call extension fields, including
 * Gemini's required signatures. Its getResponse path preserves providerData.
 * Emit the complete response once, with no invented token deltas or extra request.
 */
export function bufferedCompatibleModel(inner: Model): Model {
  return {
    getResponse: (request) => inner.getResponse(request),
    async *getStreamedResponse(request) {
      request.signal?.throwIfAborted();
      const response = await inner.getResponse(request);
      request.signal?.throwIfAborted();
      const output = response.output.filter(
        (item) => !("role" in item) || item.role === "assistant",
      ) as Extract<
        ResponseStreamEvent,
        { type: "response_done" }
      >["response"]["output"];
      yield {
        type: "response_done",
        response: {
          id: response.responseId ?? "",
          requestId: response.requestId,
          usage: response.usage,
          rawUsage: response.rawUsage,
          providerData: response.providerData,
          output,
        },
      };
    },
  };
}
