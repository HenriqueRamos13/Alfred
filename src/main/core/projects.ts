/**
 * Projects — ICM folder-as-context.
 *
 * The manifest `<proj>/.alfred/PROJECT.md` is the canonical source; the sqlite
 * `projects` table is only an index. `slugify` is pure (tested). The db param is
 * typed inline so this module never value-imports better-sqlite3.
 */

import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectManifest, ProjectRecord } from './types.ts';

type DB = import('better-sqlite3').Database;

/** URL/filesystem-safe slug: lowercase, strip diacritics, non-alphanumeric → single dash, trimmed. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function serializeManifest(m: ProjectManifest): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '_none_');
  return [
    `# ${m.name}`,
    '',
    `- **Slug:** ${m.slug}`,
    `- **Path:** ${m.path}`,
    `- **Stack:** ${m.stack}`,
    `- **Status:** ${m.status}`,
    `- **Created:** ${m.created}`,
    '',
    '## Summary',
    '',
    m.summary || '_none_',
    '',
    '## Key Files',
    '',
    list(m.keyFiles),
    '',
    '## Decisions',
    '',
    list(m.decisions),
    '',
  ].join('\n');
}

function field(md: string, label: string): string {
  const m = md.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i'));
  return m ? m[1].trim() : '';
}

function section(md: string, heading: string): string[] {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, 'i');
  const body = md.match(re)?.[1] ?? '';
  return body
    .split('\n')
    .map((l) => l.replace(/^-\s+/, '').trim())
    .filter((l) => l && l !== '_none_');
}

function parseManifest(md: string): ProjectManifest {
  const nameMatch = md.match(/^#\s+(.+)$/m);
  const summaryMatch = md.match(/##\s+Summary\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  return {
    name: nameMatch ? nameMatch[1].trim() : field(md, 'Slug'),
    slug: field(md, 'Slug'),
    path: field(md, 'Path'),
    stack: field(md, 'Stack'),
    status: field(md, 'Status'),
    created: field(md, 'Created'),
    summary: (summaryMatch?.[1] ?? '').trim().replace(/^_none_$/, ''),
    keyFiles: section(md, 'Key Files'),
    decisions: section(md, 'Decisions'),
  };
}

function manifestPath(projectPath: string): string {
  return join(projectPath, '.alfred', 'PROJECT.md');
}

export interface CreateProjectInput {
  name: string;
  stack?: string;
  summary?: string;
  status?: string;
}

export async function createProject(db: DB, workspace: string, input: CreateProjectInput): Promise<ProjectManifest> {
  const slug = slugify(input.name);
  if (!slug) throw new Error(`Cannot derive a slug from project name: ${JSON.stringify(input.name)}`);

  const path = join(workspace, 'projects', slug);
  const manifest: ProjectManifest = {
    name: input.name,
    slug,
    path,
    stack: input.stack ?? 'unspecified',
    status: input.status ?? 'active',
    summary: input.summary ?? '',
    created: new Date().toISOString(),
    keyFiles: [],
    decisions: [],
  };

  await mkdir(join(path, '.alfred'), { recursive: true });
  await writeFile(manifestPath(path), serializeManifest(manifest), 'utf8');

  db.prepare(
    `INSERT INTO projects (slug, name, path, summary, updated)
     VALUES (@slug, @name, @path, @summary, @updated)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, path=excluded.path, summary=excluded.summary, updated=excluded.updated`,
  ).run({ slug, name: manifest.name, path, summary: manifest.summary, updated: Date.now() });

  return manifest;
}

export function listProjects(db: DB): ProjectRecord[] {
  return db.prepare('SELECT slug, name, path, summary, updated FROM projects ORDER BY updated DESC').all() as ProjectRecord[];
}

/** Shallow file listing (top level + one level down) for context. */
async function fileTree(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const top = await readdir(root, { withFileTypes: true });
    for (const e of top) {
      if (e.name.startsWith('.')) continue;
      out.push(e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) {
        try {
          const sub = await readdir(join(root, e.name), { withFileTypes: true });
          for (const s of sub) {
            if (s.name.startsWith('.')) continue;
            out.push(`${e.name}/${s.name}${s.isDirectory() ? '/' : ''}`);
          }
        } catch {
          /* unreadable subdir — skip */
        }
      }
    }
  } catch {
    /* project dir gone — return what we have */
  }
  return out;
}

export interface ProjectDetail {
  manifest: ProjectManifest;
  files: string[];
}

export async function getProject(db: DB, workspace: string, slug: string): Promise<ProjectDetail | null> {
  const row = db.prepare('SELECT slug, name, path, summary, updated FROM projects WHERE slug = ?').get(slug) as
    | ProjectRecord
    | undefined;
  const path = row?.path ?? join(workspace, 'projects', slug);

  let manifest: ProjectManifest;
  try {
    manifest = parseManifest(await readFile(manifestPath(path), 'utf8'));
  } catch {
    if (!row) return null;
    manifest = {
      name: row.name,
      slug: row.slug,
      path: row.path,
      stack: 'unspecified',
      status: 'unknown',
      summary: row.summary,
      created: '',
      keyFiles: [],
      decisions: [],
    };
  }

  return { manifest, files: await fileTree(path) };
}
