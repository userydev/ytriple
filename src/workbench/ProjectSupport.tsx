import type { Snapshot } from "../shared/types";
export type ProjectSection = "software" | "media";
export function ProjectSupport({
  snapshot,
  section,
  onSection,
}: {
  snapshot: Snapshot | null;
  section: ProjectSection;
  onSection: (section: ProjectSection) => void;
}) {
  return (
    <nav className="project-section-tabs" aria-label="项目类型">
      <button
        type="button"
        aria-pressed={section === "software"}
        className={section === "software" ? "active" : ""}
        onClick={() => onSection("software")}
      >
        软件项目 <span>{snapshot?.projects.length ?? 0}</span>
      </button>
      <button
        type="button"
        aria-pressed={section === "media"}
        className={section === "media" ? "active" : ""}
        onClick={() => onSection("media")}
      >
        媒体项目 <span>{snapshot?.media?.channels.length ?? 0}</span>
      </button>
    </nav>
  );
}
