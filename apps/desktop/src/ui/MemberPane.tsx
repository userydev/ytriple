import { isSafeHttpUrl } from "@ytriple/core";
import { useState, type JSX } from "react";
import { memberStatusLabel, type MemberView, type SubAgentView } from "../state/taskView.js";
import { groupDegradations } from "./DegradationBar.js";

/**
 * One member's workbench. Everything shown here came from an event that member
 * emitted; a member with no events shows as waiting rather than as a spinner
 * pretending to make progress.
 */
export function MemberPane({ member }: { member: MemberView }): JSX.Element {
  const idle = member.status === "idle";

  return (
    <section className={`pane member-pane status-${member.status}`}>
      <header className="pane-header">
        <div>
          <h2>{member.displayName}</h2>
          <span className="muted">{member.roleDisplayName}</span>
        </div>
        <span className={`status-chip status-${member.status}`}>
          {memberStatusLabel(member.status)}
        </span>
      </header>

      <div className="pane-scroll">
        {member.objective && (
          <Block title="Objective">
            <p>{member.objective}</p>
          </Block>
        )}

        {idle && (
          <div className="empty-state small">
            <p>Waiting for dispatch.</p>
            <p className="muted">Sections this role reports: {member.panelSections.join(" · ")}</p>
          </div>
        )}

        {member.error && (
          <Block title="Blocked">
            <p className="error-text">{member.error.message}</p>
            <p className="muted">
              {member.error.retryable ? "Recoverable" : "Blocking"} — the orchestrator merges without
              this member and records the gap.
            </p>
          </Block>
        )}

        {member.stages.length > 0 && (
          <Block title="Process">
            <ol className="stage-list">
              {member.stages.map((stage, index) => (
                <li key={index}>
                  <span className="stage-name">{stage.stage}</span>
                  <span className="stage-detail">{stage.detail}</span>
                </li>
              ))}
            </ol>
          </Block>
        )}

        {member.toolCalls.length > 0 && (
          <Block title="Tool calls">
            <ul className="tool-list">
              {member.toolCalls.map((call, index) => (
                <li key={index} className={`tool-${call.outcome}`}>
                  <code>{call.tool}</code>
                  <span className="muted">{call.intent}</span>
                  <span className="tool-detail">{call.detail}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {member.subAgents.length > 0 && <SubAgentBlock subAgents={member.subAgents} />}

        {member.sources.length > 0 && (
          <Block title={`Sources (${member.sources.length})`}>
            <ul className="source-list">
              {member.sources.map((source) => (
                <li key={source.url}>
                  {/* Search results are untrusted input; only link http(s). */}
                  {isSafeHttpUrl(source.url) ? (
                    <a href={source.url} target="_blank" rel="noreferrer noopener">
                      {source.title}
                    </a>
                  ) : (
                    <span>
                      {source.title} <span className="muted">(unsupported link: {source.url})</span>
                    </span>
                  )}
                  {source.snippet && <p className="muted">{source.snippet}</p>}
                  <span className="tag">{source.origin.replace(/_/g, " ")}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {member.degradations.length > 0 && (
          <Block title="Degradations">
            <ul className="degradation-list">
              {/* Grouped: a JSON-mode model reports the same one on every call. */}
              {groupDegradations(
                member.degradations.map((degradation) => ({ degradation })),
              ).map((group, index) => (
                <li key={index}>
                  <span className="tag tag-warn">{group.degradation.kind}</span>
                  {group.degradation.from} → {group.degradation.to}
                  {group.count > 1 && <span className="muted"> ×{group.count}</span>}
                  <p className="muted">{group.degradation.detail}</p>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {member.contribution && (
          <ContributionBlock
            schemaId={member.contribution.schemaId}
            payload={member.contribution.payload}
          />
        )}
      </div>

      {(member.usage.inputTokens > 0 || member.usage.outputTokens > 0) && (
        <footer className="pane-footer muted">
          {member.usage.inputTokens} in / {member.usage.outputTokens} out
          {member.subAgents.length > 0 && ` · includes ${member.subAgents.length} sub-task(s)`}
        </footer>
      )}
    </section>
  );
}

/**
 * Sub-agents are the parent's implementation detail: one collapsed line by
 * default, expandable into the nested process. They never appear as team
 * members.
 */
function SubAgentBlock({ subAgents }: { subAgents: SubAgentView[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="block subagent-block">
      <button className="subagent-toggle" type="button" onClick={() => setExpanded(!expanded)}>
        <span className="brief-chevron">{expanded ? "▾" : "▸"}</span>
        {subAgents.length} sub-task{subAgents.length === 1 ? "" : "s"}
        <span className="muted">
          {subAgents.filter((entry) => entry.status === "completed").length} completed
          {subAgents.some((entry) => entry.status === "aborted") ? ", 1 or more aborted" : ""}
        </span>
      </button>

      {expanded && (
        <div className="subagent-body">
          {subAgents.map((subAgent) => (
            <article className={`subagent subagent-${subAgent.status}`} key={subAgent.subAgentId}>
              <header>
                <code>{subAgent.subAgentId}</code>
                <span className={`status-chip status-${subAgent.status}`}>{subAgent.status}</span>
              </header>
              <p>{subAgent.objective}</p>
              <p className="muted">
                depth {subAgent.depth} · budget {subAgent.tokenBudget} tokens
                {subAgent.tokensUsed !== undefined && ` · used ${subAgent.tokensUsed}`}
                {subAgent.tools.length > 0 && ` · tools ${subAgent.tools.join(", ")}`}
              </p>
              {subAgent.toolCalls.length > 0 && (
                <ul className="tool-list">
                  {subAgent.toolCalls.map((call, index) => (
                    <li key={index} className={`tool-${call.outcome}`}>
                      <code>{call.tool}</code>
                      <span className="tool-detail">{call.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {subAgent.summary && <p className="subagent-summary">{subAgent.summary}</p>}
              {subAgent.abortDetail && (
                <p className="error-text">
                  aborted ({subAgent.abortReason}): {subAgent.abortDetail}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Contributions are opaque to the runtime, so they are rendered generically:
 * whatever the role's schema produced, shown by field.
 */
function ContributionBlock({
  schemaId,
  payload,
}: {
  schemaId: string;
  payload: Record<string, unknown>;
}): JSX.Element {
  return (
    <div className="block contribution-block">
      <h3>
        Contribution <code className="muted">{schemaId}</code>
      </h3>
      {/* An empty field means the member had nothing to say there; a bare
          heading with nothing under it just looks like a rendering bug. */}
      {Object.entries(payload)
        .filter(([, value]) => !isEmptyValue(value))
        .map(([key, value]) => (
          <div className="contribution-field" key={key}>
            <h4>{key.replace(/_/g, " ")}</h4>
            {renderValue(value)}
          </div>
        ))}
    </div>
  );
}

function renderValue(value: unknown): JSX.Element {
  if (typeof value === "string") return <p>{value}</p>;
  if (typeof value === "number" || typeof value === "boolean") return <p>{String(value)}</p>;

  if (Array.isArray(value)) {
    return (
      <ul>
        {value.map((entry, index) => (
          <li key={index}>{typeof entry === "string" ? entry : renderValue(entry)}</li>
        ))}
      </ul>
    );
  }

  if (value && typeof value === "object") {
    return (
      <dl className="contribution-object">
        {Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
          <div key={key}>
            <dt>{key.replace(/_/g, " ")}</dt>
            <dd>{typeof entry === "string" ? entry : JSON.stringify(entry)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return <p className="muted">—</p>;
}

export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function Block({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div className="block">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
