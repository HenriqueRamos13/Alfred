/**
 * ProjectList — ICM projects index (manifest-backed).
 * Theme tokens: see Panel.tsx.
 */
export interface ProjectListItem {
  name: string;
  slug: string;
  summary: string;
  /** Epoch ms of last update. */
  updated: number;
}

const fmt = (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export interface ProjectListProps {
  projects: ProjectListItem[];
}

export function ProjectList({ projects }: ProjectListProps) {
  if (projects.length === 0) {
    return <div style={{ color: 'var(--text-dim, #7c8ba1)', fontSize: 13 }}>No projects yet.</div>;
  }
  return (
    <div className="alfred-projectlist" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {projects.map((p) => (
        <div
          key={p.slug}
          style={{
            background: 'var(--panel-2, #131b2b)',
            border: '1px solid var(--border, #1e2a3a)',
            borderLeft: '2px solid var(--neon-cyan, #22d3ee)',
            borderRadius: 6,
            padding: '10px 12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ color: 'var(--text, #e5eef7)', fontWeight: 600 }}>{p.name}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 11,
                color: 'var(--neon-cyan, #22d3ee)',
              }}
            >
              {p.slug}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim, #7c8ba1)' }}>
              {fmt(p.updated)}
            </span>
          </div>
          {p.summary && (
            <div style={{ fontSize: 12, color: 'var(--text-dim, #7c8ba1)', marginTop: 4 }}>{p.summary}</div>
          )}
        </div>
      ))}
    </div>
  );
}
