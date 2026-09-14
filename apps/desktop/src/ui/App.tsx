import type { YtripleConfig } from "@ytriple/shared";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { DesktopHost, DesktopSettings, HistoryRecord } from "../host/types.js";
import { layoutMembers } from "../state/layout.js";
import { credentialRefsOf, defaultSettings, teamFromSettings } from "../state/settings.js";
import { taskStatusLabel } from "../state/taskView.js";
import { useTaskSession } from "../state/useTaskSession.js";
import { ChatPane } from "./ChatPane.js";
import { DegradationBar, groupDegradations } from "./DegradationBar.js";
import { HistoryView } from "./HistoryView.js";
import { MemberPane } from "./MemberPane.js";
import { PrdPreview } from "./PrdPreview.js";
import { SettingsView } from "./SettingsView.js";

type View = "workspace" | "history" | "settings";

export function App({ host, placeholder }: { host: DesktopHost; placeholder: string }): JSX.Element {
  const [config, setConfig] = useState<YtripleConfig | undefined>(undefined);
  const [settings, setSettings] = useState<DesktopSettings | undefined>(undefined);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [credentials, setCredentials] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>("workspace");
  const [showPrd, setShowPrd] = useState(true);

  useEffect(() => {
    void (async () => {
      const loadedConfig = await host.loadConfig();
      setConfig(loadedConfig);
      setSettings((await host.loadSettings()) ?? defaultSettings(loadedConfig));
      setHistory(await host.listHistory());
      setCredentials(await host.credentialStatus(credentialRefsOf(loadedConfig)));
    })();
  }, [host]);

  const team = useMemo(
    () => (settings ? teamFromSettings(settings) : undefined),
    [settings],
  );

  const onFinished = useCallback(
    (record: HistoryRecord) => {
      setHistory((current) => [record, ...current.filter((entry) => entry.taskId !== record.taskId)]);
      setShowPrd(true);
    },
    [],
  );

  if (!config || !settings || !team) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <AppShell
      host={host}
      config={config}
      settings={settings}
      team={team}
      history={history}
      credentials={credentials}
      view={view}
      showPrd={showPrd}
      placeholder={placeholder}
      onView={setView}
      onShowPrd={setShowPrd}
      onFinished={onFinished}
      onSettings={(next) => {
        setSettings(next);
        void host.saveSettings(next);
      }}
      onCredentialsRefreshed={() => {
        void host.credentialStatus(credentialRefsOf(config)).then(setCredentials);
      }}
    />
  );
}

interface ShellProps {
  host: DesktopHost;
  config: YtripleConfig;
  settings: DesktopSettings;
  team: ReturnType<typeof teamFromSettings>;
  history: HistoryRecord[];
  credentials: Record<string, boolean>;
  view: View;
  showPrd: boolean;
  placeholder: string;
  onView(view: View): void;
  onShowPrd(show: boolean): void;
  onFinished(record: HistoryRecord): void;
  onSettings(settings: DesktopSettings): void;
  onCredentialsRefreshed(): void;
}

function AppShell(props: ShellProps): JSX.Element {
  const { host, config, settings, team, view } = props;

  const session = useTaskSession(
    host,
    team,
    config,
    settings.workspaceRoot,
    props.onFinished,
  );
  const { view: taskView } = session;
  const layout = layoutMembers(taskView.members);
  const displayNames = Object.fromEntries(
    team.members.map((member) => [member.agentId, member.displayName]),
  );

  const prdVisible = props.showPrd && taskView.artifact !== undefined;

  return (
    <div className="app">
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark">yTriple</span>
          <span className="muted">{team.name}</span>
        </div>

        <div className="status-line">
          <span className={`status-chip status-task-${taskView.status}`}>
            {taskStatusLabel(taskView.status)}
          </span>
          <span className="muted">
            {taskView.eventCount} events · {taskView.usage.inputTokens} in /{" "}
            {taskView.usage.outputTokens} out
          </span>
          {view === "workspace" && taskView.artifact && (
            <button
              type="button"
              className="artifact-toggle"
              onClick={() => props.onShowPrd(!prdVisible)}
            >
              {prdVisible ? "Back to conversation" : `Show ${taskView.artifact.filename}`}
            </button>
          )}
        </div>

        <nav className="view-switch">
          {(["workspace", "history", "settings"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              className={view === entry ? "is-active" : ""}
              onClick={() => props.onView(entry)}
            >
              {entry}
            </button>
          ))}
        </nav>
      </header>

      {host.info.replayNotice && (
        <div className="host-notice">
          <strong>{host.info.label}.</strong> {host.info.replayNotice}
        </div>
      )}

      <DegradationBar
        groups={groupDegradations(taskView.degradations)}
        displayNames={displayNames}
      />

      {view === "workspace" && (
        <main className={`bays bays-${layout.bays.length}`}>
          {layout.bays[0] && <SideBay bay={layout.bays[0]} />}

          {prdVisible && taskView.artifact ? (
            <PrdPreview
              filename={taskView.artifact.filename}
              path={taskView.artifact.path}
              markdown={session.result?.prd?.markdown ?? ""}
              canReveal={host.info.canRevealOutput}
              onReveal={() => void host.revealOutput(taskView.taskId)}
              onClose={() => props.onShowPrd(false)}
            />
          ) : (
            <ChatPane
              chat={taskView.chat}
              brief={taskView.brief}
              displayNames={displayNames}
              pendingQuestions={session.pendingQuestions}
              running={session.running}
              onStart={session.start}
              onAnswer={session.answer}
              placeholder={props.placeholder}
            />
          )}

          {layout.bays[1] && <SideBay bay={layout.bays[1]} />}
        </main>
      )}

      {view === "history" && (
        <main className="single">
          <HistoryView
            records={props.history}
            canReveal={host.info.canRevealOutput}
            onReveal={(taskId) => void host.revealOutput(taskId)}
          />
        </main>
      )}

      {view === "settings" && (
        <main className="single">
          <SettingsView
            host={host}
            config={config}
            team={team}
            settings={settings}
            credentials={props.credentials}
            onChange={props.onSettings}
            onCredentialSaved={props.onCredentialsRefreshed}
          />
        </main>
      )}

    </div>
  );
}

function SideBay({ bay }: { bay: ReturnType<typeof layoutMembers>["bays"][number] }): JSX.Element {
  return (
    <div className={`bay bay-${bay.id} ${bay.split ? "is-split" : ""}`}>
      {bay.members.map((member) => (
        <MemberPane key={member.agentId} member={member} />
      ))}
    </div>
  );
}
