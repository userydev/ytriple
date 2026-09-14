import type {
  ClockPort,
  RuntimeEvent,
  RuntimeEventBody,
  RuntimeEventListener,
  TaskId,
} from "@ytriple/shared";

export interface EventBus {
  emit(body: RuntimeEventBody): RuntimeEvent;
  subscribe(listener: RuntimeEventListener): () => void;
  /** Replayable history; a UI that attaches late still renders the full run. */
  history(): RuntimeEvent[];
}

export function createEventBus(taskId: TaskId, clock: ClockPort): EventBus {
  const listeners = new Set<RuntimeEventListener>();
  const events: RuntimeEvent[] = [];
  let seq = 0;

  return {
    emit(body) {
      const event: RuntimeEvent = { taskId, seq: seq++, at: clock.now(), body };
      events.push(event);
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    history: () => [...events],
  };
}
