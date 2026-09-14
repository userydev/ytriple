import type { TaskBrief } from "@ytriple/shared";
import { useState, type JSX } from "react";

/**
 * The Task Brief, visible before anyone is dispatched. It is collapsible
 * because it stays on screen for the rest of the run as the context everything
 * else refers back to.
 */
export function TaskBriefCard({
  brief,
  displayNames,
}: {
  brief: TaskBrief;
  displayNames: Record<string, string>;
}): JSX.Element {
  const [open, setOpen] = useState(true);

  return (
    <section className={`brief-card ${open ? "is-open" : "is-closed"}`}>
      <button className="brief-toggle" onClick={() => setOpen(!open)} type="button">
        <span className="brief-chevron">{open ? "▾" : "▸"}</span>
        <span className="brief-title">Task Brief</span>
        <span className="brief-subtitle">{brief.productObject}</span>
      </button>

      {open && (
        <div className="brief-body">
          <dl className="brief-grid">
            <Field label="Target user" value={brief.targetUser} />
            <Field label="Core scenario" value={brief.coreScenario} />
            <Field label="Problem" value={brief.painOrProblem} />
          </dl>

          <div className="brief-lists">
            <BriefList label="V1 scope" items={brief.v1Scope} />
            <BriefList label="Non-goals" items={brief.nonGoals} />
            <BriefList label="Success criteria" items={brief.successCriteria} />
            <BriefList label="Assumptions" items={brief.assumptions} />
            <BriefList label="Open questions" items={brief.openQuestions} />
          </div>

          <div className="brief-members">
            <h4>Dispatch</h4>
            {brief.memberTasks.map((task) => (
              <div className="brief-member" key={task.agentId}>
                <span className="pill">{displayNames[task.agentId] ?? task.agentId}</span>
                <p>{task.objective}</p>
                {task.mustCover.length > 0 && (
                  <p className="muted">Must cover: {task.mustCover.join("; ")}</p>
                )}
                {task.outOfScope.length > 0 && (
                  <p className="muted">Out of scope: {task.outOfScope.join("; ")}</p>
                )}
              </div>
            ))}
          </div>

          <p className="brief-availability">
            Context: workspace {brief.contextAvailability.workspace ? "available" : "unavailable"} ·
            web search {brief.contextAvailability.webSearch ? "available" : "unavailable"}
          </p>
        </div>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function BriefList({ label, items }: { label: string; items: string[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="brief-list">
      <h4>{label}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
