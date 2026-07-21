import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolCtx } from './types.ts';

type Op = 'read' | 'write' | 'list' | 'mkdir' | 'delete';
interface Args {
  op: Op;
  path: string;
  content?: string;
  recursive?: boolean;
}

/** Absolute paths pass through; relative ones resolve against the workspace. */
function resolvePath(ctx: ToolCtx, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.workspace, p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export const filesystem: Tool<Args> = {
  name: 'filesystem',
  description:
    'Read, write, list, create and delete files/directories on the Mac. ' +
    'Absolute paths are used as-is; relative paths resolve against the Alfred workspace. ' +
    'Overwriting an existing file and deleting anything require human approval.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['read', 'write', 'list', 'mkdir', 'delete'],
        description: 'Operation to perform.',
      },
      path: { type: 'string', description: 'Target file or directory path.' },
      content: { type: 'string', description: 'File contents (op=write).' },
      recursive: {
        type: 'boolean',
        description: 'op=mkdir: create parents. op=delete: remove directory tree.',
      },
    },
    required: ['op', 'path'],
  },

  risk: (a) => (a.op === 'delete' ? 'T2' : a.op === 'read' || a.op === 'list' ? 'T0' : 'T1'),

  async execute(a, ctx) {
    const target = resolvePath(ctx, a.path);
    try {
      switch (a.op) {
        case 'read': {
          const content = await fs.readFile(target, 'utf8');
          return { ok: true, result: { path: target, content } };
        }
        case 'list': {
          const entries = await fs.readdir(target, { withFileTypes: true });
          const items = await Promise.all(
            entries.map(async (e) => {
              const full = path.join(target, e.name);
              let size = 0;
              if (e.isFile()) {
                try {
                  size = (await fs.stat(full)).size;
                } catch {
                  /* race: entry vanished */
                }
              }
              return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
            }),
          );
          return { ok: true, result: { path: target, entries: items } };
        }
        case 'mkdir':
          await fs.mkdir(target, { recursive: a.recursive ?? true });
          return { ok: true, result: { path: target } };
        case 'write': {
          if (await exists(target)) {
            const res = await ctx.governance.requestApproval({
              sessionId: ctx.sessionId,
              toolName: this.name,
              args: { op: a.op, path: target },
              tier: 'T2',
              reason: `Overwrite existing file ${target}`,
            });
            if (res.decision !== 'approve')
              return { ok: false, error: res.timedOut ? 'Approval timed out — denied' : 'Denied by user' };
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, a.content ?? '', 'utf8');
          return { ok: true, result: { path: target, bytes: Buffer.byteLength(a.content ?? '') } };
        }
        case 'delete': {
          const res = await ctx.governance.requestApproval({
            sessionId: ctx.sessionId,
            toolName: this.name,
            args: { op: a.op, path: target, recursive: a.recursive },
            tier: 'T2',
            reason: `Delete ${target}${a.recursive ? ' (recursive)' : ''}`,
          });
          if (res.decision !== 'approve')
            return { ok: false, error: res.timedOut ? 'Approval timed out — denied' : 'Denied by user' };
          await fs.rm(target, { recursive: a.recursive ?? false, force: false });
          return { ok: true, result: { path: target, deleted: true } };
        }
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
