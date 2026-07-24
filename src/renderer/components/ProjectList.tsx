/**
 * ProjectList — ICM projects index (manifest-backed).
 * Neon styling via .projects/.project* classes in theme.css.
 */
import { relativeTime } from '../../main/core/jobs-format-pure.ts';

export interface ProjectListItem {
  name: string;
  slug: string;
  /** Filesystem path used as the project's context root. */
  path?: string;
  summary: string;
  /** Epoch ms of last update. */
  updated: number;
}

export interface ProjectListProps {
  projects: ProjectListItem[];
  /** Open the per-project modal (Board / Overview). Absent when the AI renders this via render_ui. */
  onOpen?: (slug: string) => void;
}

export function ProjectList({ projects, onOpen }: ProjectListProps) {
  if (projects.length === 0) {
    return <div className="empty">NO PROJECTS YET</div>;
  }
  const now = Date.now();
  return (
    <div className="projects">
      {projects.map((p) => (
        <div key={p.slug} className="project">
          <div className="project-head">
            <span className="project-name">{p.name}</span>
            <span className="project-slug">{p.slug}</span>
            <span className="project-date">{relativeTime(p.updated, now)}</span>
            {onOpen && (
              <button type="button" className="project-open no-drag" onClick={() => onOpen(p.slug)} title="Open project board">
                OPEN
              </button>
            )}
          </div>
          <div className="project-meta">{p.path ?? p.slug}</div>
          {p.summary && <div className="project-summary">{p.summary}</div>}
        </div>
      ))}
    </div>
  );
}
