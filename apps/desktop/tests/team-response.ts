import type { Store } from "../src/core/store";
import type { Model, Prompt } from "../src/core/ycore";

export function boundBaseFromPrompt(prompt: Prompt): string | null {
  const system =
    prompt.messages.find((m) => m.role === "system")?.content ?? "";
  const marker = system.match(/YTRIPLE_BOUND_BASE=(null|"[^"]*")/)?.[1];
  if (!marker || marker === "null") return null;
  return marker.slice(1, -1);
}

export function teamResponse(
  answer: string,
  artifact: null | { body: string; baseVersionId: string | null } = null,
) {
  return JSON.stringify({ ytriple_response: { answer, artifact } });
}

export function protocolModel(model: Model): Model {
  return {
    scope: model.scope,
    recovery: model.recovery,
    identity: model.identity,
    lookup: model.lookup?.bind(model),
    lookupByKey: model.lookupByKey?.bind(model),
    async *stream(prompt, key, signal) {
      for await (const event of model.stream(prompt, key, signal)) {
        if (event.type !== "text.delta" || !event.text?.trim()) {
          yield event;
          continue;
        }
        const raw = event.text;
        if (raw.trimStart().startsWith("{") && raw.includes("ytriple_")) {
          yield event;
          continue;
        }
        const system =
          prompt.messages.find((m) => m.role === "system")?.content ?? "";
        if (!system.includes("YTRIPLE_BOUND_BASE=")) {
          yield event;
          continue;
        }
        const allowsArtifact = !system.includes("不允许提交 artifact");
        const baseVersionId = boundBaseFromPrompt(prompt);
        yield {
          ...event,
          text: teamResponse(
            raw,
            allowsArtifact ? { body: raw, baseVersionId } : null,
          ),
        };
      }
    },
  };
}

/** Direct store.finish in tests that intentionally use legacy plain-text outcomes. */
export function legacyFinish(
  store: Store,
  runId: string,
  body: string,
  allowsArtifact: boolean,
) {
  store.setRun(runId, { responseProtocol: undefined });
  return store.finish(runId, body, allowsArtifact);
}
