import type { Tool } from './types.ts';
// Logic lives in core/projects.ts (manifest = canonical, sqlite = index); this is a thin wrapper.
import { createProject, listProjects, getProject } from '../core/projects.ts';

type Op = 'create' | 'list' | 'get';
interface Args {
  op: Op;
  name?: string;
  slug?: string;
  stack?: string;
  summary?: string;
}

export const project: Tool<Args> = {
  name: 'project',
  description:
    'Manage ICM folder-as-context projects under the workspace. ' +
    'create: scaffold a project folder + .alfred/PROJECT.md manifest and index it. ' +
    'list: enumerate known projects. get: load a project manifest + file tree by slug.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['create', 'list', 'get'] },
      name: { type: 'string', description: 'op=create: human project name.' },
      slug: { type: 'string', description: 'op=get: project slug.' },
      stack: { type: 'string', description: 'op=create: tech stack (e.g. "Next.js").' },
      summary: { type: 'string', description: 'op=create: one-line summary.' },
    },
    required: ['op'],
  },

  // create writes to the workspace (reversible); list/get are read-only.
  risk: (a) => (a.op === 'create' ? 'T1' : 'T0'),

  async execute(a, ctx) {
    try {
      switch (a.op) {
        case 'create': {
          if (!a.name) return { ok: false, error: 'name is required for create' };
          const manifest = await createProject(ctx.db, ctx.workspace, {
            name: a.name,
            stack: a.stack ?? '',
            summary: a.summary ?? '',
          });
          return { ok: true, result: manifest };
        }
        case 'list':
          return { ok: true, result: { projects: listProjects(ctx.db) } };
        case 'get': {
          if (!a.slug) return { ok: false, error: 'slug is required for get' };
          const found = await getProject(ctx.db, ctx.workspace, a.slug);
          if (!found) return { ok: false, error: `No project with slug "${a.slug}"` };
          return { ok: true, result: found };
        }
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
