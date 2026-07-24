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
import { delegateToAgent } from './delegate-to-agent.ts';
import { agentStudy } from './agent-study.ts';
import { uiLayout } from './uiLayout.ts';
import { system } from './system.ts';
import { schedule } from './schedule.ts';
import { team } from './team.ts';
import { kanban } from './kanban.ts';
import { inbox } from './inbox.ts';
import { recallSessions } from './recall-sessions.ts';

export { createBrowserHandle } from './browser.ts';

export const tools: Tool[] = [filesystem, shell, browser, project, gmail, renderUi, memory, delegate, delegateToAgent, agentStudy, uiLayout, system, schedule, team, kanban, inbox, recallSessions];

/** Lookup by tool name (for the orchestrator's tool-use dispatch). */
export const toolsByName: Record<string, Tool> = Object.fromEntries(tools.map((t) => [t.name, t]));

/**
 * CORE tools — the small always-loaded set that NEVER defers (progressive tool
 * disclosure, Phase 6 Stage 1). Everything else (browser, gmail, project,
 * render_ui, delegate*, agent_study, team, kanban, inbox, schedule, recall_sessions, + MCP tools) is
 * DEFERRABLE: hidden behind the tool_search/tool_describe/tool_call bridge once
 * the deferrable defs would blow the token budget. See tool-disclosure-pure.ts.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set(['filesystem', 'shell', 'system', 'memory', 'ui_layout']);

/** True when a tool is in the always-loaded core set. */
export const isCoreTool = (name: string): boolean => CORE_TOOLS.has(name);
