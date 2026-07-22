/**
 * Tool registry. Only this file is edited to add/remove tools.
 *
 * HITL is tool-driven: each tool declares its risk tier via `risk?(args)` (used for
 * audit + trifecta) and calls `ctx.governance.requestApproval(...)` itself for the
 * cases static classification can't see — overwriting an existing file, destructive
 * shell, deletes, a browser login wall, connecting an account. requestApproval blocks
 * until the human resolves it (timeout = deny).
 */
import type { Tool } from './types.ts';
import { filesystem } from './filesystem.ts';
import { shell } from './shell.ts';
import { browser } from './browser.ts';
import { project } from './project.ts';
import { gmail } from './gmail.ts';
import { renderUi } from './renderUi.ts';
import { memory } from './memory.ts';
import { delegate } from './delegate.ts';
import { uiLayout } from './uiLayout.ts';
import { system } from './system.ts';

export { createBrowserHandle } from './browser.ts';

export const tools: Tool[] = [filesystem, shell, browser, project, gmail, renderUi, memory, delegate, uiLayout, system];

/** Lookup by tool name (for the orchestrator's tool-use dispatch). */
export const toolsByName: Record<string, Tool> = Object.fromEntries(tools.map((t) => [t.name, t]));
