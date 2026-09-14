import type { TaskRunResult } from "@ytriple/core";
import type { AgentAnswer, AgentQuestion, RuntimeEvent, TeamDefinition, YtripleConfig } from "@ytriple/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { createInteractiveUserPort } from "../host/interactiveUser.js";
import type { DesktopHost, HistoryRecord } from "../host/types.js";
import { buildTaskView, type TaskView } from "./taskView.js";

export interface TaskSession {
  view: TaskView;
  running: boolean;
  pendingQuestions: AgentQuestion[];
  result?: TaskRunResult;
  start(userInput: string): void;
  answer(answers: AgentAnswer[]): void;
  reset(): void;
}

let taskCounter = 0;

/**
 * Holds one task run. The whole UI is derived from `events`, so nothing on
 * screen can get ahead of what the runtime actually reported.
 */
export function useTaskSession(
  host: DesktopHost,
  team: TeamDefinition,
  config: YtripleConfig,
  workspaceRoot: string | undefined,
  onFinished?: (record: HistoryRecord) => void,
): TaskSession {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [taskId, setTaskId] = useState(() => `task-${Date.now().toString(36)}`);
  const [running, setRunning] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<AgentQuestion[]>([]);
  const [result, setResult] = useState<TaskRunResult | undefined>(undefined);
  const userPortRef = useRef<ReturnType<typeof createInteractiveUserPort> | undefined>(undefined);

  const start = useCallback(
    (userInput: string) => {
      if (running || userInput.trim().length === 0) return;

      taskCounter += 1;
      const nextTaskId = `task-${Date.now().toString(36)}-${taskCounter}`;
      setTaskId(nextTaskId);
      setEvents([]);
      setResult(undefined);
      setRunning(true);

      const user = createInteractiveUserPort(setPendingQuestions);
      userPortRef.current = user;

      const runtime = host.createRuntime({
        taskId: nextTaskId,
        team,
        config,
        user,
        workspaceRoot,
      });

      runtime.subscribe((event) => {
        setEvents((current) => [...current, event]);
      });

      void runtime
        .run({ userInput: userInput.trim() })
        .then((runResult) => {
          setResult(runResult);
          const record: HistoryRecord = {
            taskId: nextTaskId,
            title: runResult.brief?.productObject ?? userInput.trim().slice(0, 80),
            createdAt: Date.now(),
            status: runResult.status,
            eventCount: runResult.events.length,
            memberIds: runResult.contributions.map((contribution) => contribution.agentId),
            ...(runResult.prd ? { prdPath: runResult.prd.path, prdMarkdown: runResult.prd.markdown } : {}),
          };
          void host.saveHistory(record).then(() => onFinished?.(record));
        })
        .finally(() => {
          setRunning(false);
          setPendingQuestions([]);
        });
    },
    [config, host, onFinished, running, team, workspaceRoot],
  );

  const answer = useCallback((answers: AgentAnswer[]) => {
    userPortRef.current?.submit(answers);
  }, []);

  const reset = useCallback(() => {
    userPortRef.current?.cancel();
    setEvents([]);
    setResult(undefined);
    setPendingQuestions([]);
    setTaskId(`task-${Date.now().toString(36)}`);
  }, []);

  const view = useMemo(() => buildTaskView(team, taskId, events), [team, taskId, events]);

  return {
    view,
    running,
    pendingQuestions,
    ...(result ? { result } : {}),
    start,
    answer,
    reset,
  };
}
