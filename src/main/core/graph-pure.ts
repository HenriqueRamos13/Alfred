/**
 * Knowledge-graph PURE logic (Phase 3). No `node:*` imports — the renderer
 * imports these as VALUES (the graph card runs the force sim + maps live tool
 * events to nodes in the browser), so this must stay strip-types-safe and
 * node-free, like reset-pure.ts / settings-pure.ts. The IO side (reading the
 * vault + backlinks) lives in graph.ts and composes buildGraph().
 */

export type GraphNodeType = 'note' | 'project';

export interface GraphNode {
  /** `note:<slug>` or `project:<slug>` — unique across the graph. */
  id: string;
  type: GraphNodeType;
  label: string;
  slug: string;
  /** For notes: the note's own type (note|project|person|tool|decision). */
  noteType?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** note↔note wikilink = 'link'; note↔project membership = 'belongs'. */
  type: 'link' | 'belongs';
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type NoteLite = { title: string; type: string };

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Build the vault graph from notes, projects and a backlink map
 * (target-title → source-slugs, exactly what buildBacklinks / the curator's
 * .index/backlinks.json produces). Pure + deterministic.
 *
 * Edges point source-note → resolved-target: another note ('link') or a
 * project ('belongs', membership via a [[Project]] wikilink). Dangling links
 * (targets that resolve to no node) are dropped; edges are deduped.
 */
export function buildGraph(
  notes: { slug: string; note: NoteLite }[],
  projects: { slug: string; name: string }[],
  backlinks: Record<string, string[]> = {},
): Graph {
  const nodes: GraphNode[] = [];
  const noteByTitle = new Map<string, string>();
  const noteBySlug = new Map<string, string>();
  const projByKey = new Map<string, string>();

  for (const { slug, note } of notes) {
    const id = `note:${slug}`;
    const label = note.title || slug;
    nodes.push({ id, type: 'note', label, slug, noteType: note.type });
    noteByTitle.set(norm(label), id);
    noteBySlug.set(slug, id);
  }
  for (const { slug, name } of projects) {
    const id = `project:${slug}`;
    const label = name || slug;
    nodes.push({ id, type: 'project', label, slug });
    projByKey.set(norm(label), id);
    projByKey.set(norm(slug), id);
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [target, sources] of Object.entries(backlinks)) {
    const asNote = noteByTitle.get(norm(target));
    const asProject = projByKey.get(norm(target));
    const targetId = asNote ?? asProject; // prefer a note when a title matches both
    if (!targetId) continue;
    for (const src of sources) {
      const sourceId = noteBySlug.get(src);
      if (!sourceId || sourceId === targetId) continue;
      const key = `${sourceId}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: sourceId, target: targetId, type: asNote ? 'link' : 'belongs' });
    }
  }
  return { nodes, edges };
}

// ── Live activity: map a tool.start event to a node target (ZERO AI cost) ─────

export type ActivityKind = 'note' | 'project' | 'file' | 'url';

export interface ActivityTarget {
  kind: ActivityKind;
  /** Raw reference from the tool args (title/slug/path/url). */
  ref: string;
  label: string;
  /** True when the op mutates (edit/write) → amber; false = read → cyan pulse. */
  write: boolean;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
};

/**
 * Extract the node a tool call touches from its (toolName, args). Only the
 * tools whose target maps onto a vault node are handled; everything else
 * returns null (no highlight). Pure — the renderer calls this on the existing
 * tool.start StreamEvent; no new tools, no extra AI calls.
 */
export function toolEventTarget(toolName: string, args: unknown): ActivityTarget | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const op = asStr(a.op);
  switch (toolName) {
    case 'memory': {
      // Only op:"note" clearly targets a note (by title); other ops carry no node.
      const title = asStr(a.title);
      if (!title) return null;
      return { kind: 'note', ref: title, label: title, write: op === 'note' };
    }
    case 'filesystem': {
      const p = asStr(a.path);
      if (!p) return null;
      return { kind: 'file', ref: p, label: baseName(p), write: !(op === 'read' || op === 'list') };
    }
    case 'browser': {
      const url = asStr(a.url);
      if (!url) return null;
      return { kind: 'url', ref: url, label: hostOf(url), write: false };
    }
    case 'project': {
      const ref = asStr(a.slug) || asStr(a.name);
      if (!ref) return null;
      return { kind: 'project', ref, label: asStr(a.name) || ref, write: op === 'create' };
    }
    default:
      return null;
  }
}

export interface ResolvedActivity {
  id: string;
  label: string;
  kind: ActivityKind;
  /** True when the node is NOT part of the persisted graph (fades after activity). */
  transient: boolean;
  write: boolean;
}

/**
 * Resolve an activity target against the current graph nodes. Notes/projects
 * that exist light their real node; files/urls (never in the base graph) and
 * unknown notes become TRANSIENT nodes (id prefixed by kind) that fade unless
 * pinned. Pure so the renderer and tests agree.
 */
export function resolveActivity(nodes: GraphNode[], t: ActivityTarget): ResolvedActivity {
  if (t.kind === 'note' || t.kind === 'project') {
    const found = nodes.find(
      (n) => n.type === t.kind && (n.slug === t.ref || norm(n.label) === norm(t.ref)),
    );
    if (found) return { id: found.id, label: found.label, kind: t.kind, transient: false, write: t.write };
  }
  return { id: `${t.kind}:${t.ref}`, label: t.label, kind: t.kind, transient: true, write: t.write };
}

/** How long a highlight stays fully lit, then how long it fades to nothing. */
export const ACTIVITY_HOLD_MS = 1400;
export const ACTIVITY_FADE_MS = 1200;

/** Highlight intensity (1→0) for an activity of age `ageMs`. A transient node at 0 (unpinned) is dropped. */
export function activityIntensity(ageMs: number): number {
  if (ageMs <= ACTIVITY_HOLD_MS) return 1;
  if (ageMs >= ACTIVITY_HOLD_MS + ACTIVITY_FADE_MS) return 0;
  return 1 - (ageMs - ACTIVITY_HOLD_MS) / ACTIVITY_FADE_MS;
}
