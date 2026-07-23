/**
 * Knowledge-graph IO (Phase 3). Reads the vault (notes + curator backlinks) and
 * the project registry, then composes the PURE buildGraph() from graph-pure.ts.
 * Node-only (fs); the renderer imports just the types from graph-pure.ts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listNotes, buildBacklinks, readNote, serializeNote } from './memory.ts';
import { slugify } from './projects.ts';
import { buildGraph, type Graph } from './graph-pure.ts';

export type { Graph, GraphNode, GraphEdge } from './graph-pure.ts';

/** The curator's rebuildable backlink cache (memory/.index/backlinks.json), or null. */
async function readBacklinks(workspace: string): Promise<Record<string, string[]> | null> {
  // Path mirrors memory.ts `paths().backlinks`; kept inline to avoid exporting plumbing.
  const raw = await readFile(join(workspace, 'memory', '.index', 'backlinks.json'), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, string[]>) : null;
  } catch {
    return null;
  }
}

/**
 * Build the live vault graph: notes + projects as nodes, wikilinks/backlinks as
 * edges. Uses the curator's backlinks.json when present, else recomputes from
 * the notes' wikilinks (same source of truth, just not cached yet).
 */
export async function getGraph(workspace: string, projects: { slug: string; name: string }[]): Promise<Graph> {
  const notes = await listNotes(workspace);
  const backlinks = (await readBacklinks(workspace)) ?? buildBacklinks(notes);
  return buildGraph(notes, projects, backlinks);
}

/** Read-only note preview (canonical markdown) for the graph card's node panel. Null when absent. */
export async function getNote(workspace: string, ref: string): Promise<{ title: string; markdown: string } | null> {
  // Accept a slug or a title (the graph node carries the slug).
  const note = await readNote(workspace, slugify(ref));
  if (!note) return null;
  return { title: note.title || ref, markdown: serializeNote(note) };
}
