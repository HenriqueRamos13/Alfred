/**
 * CommandBar pure helpers (renderer-safe — no node:*).
 */
import type { AgentStatus } from './types.ts';

/**
 * Primary button role: while the agent is processing (thinking/tool) the button
 * is a soft-STOP (cancel the turn); otherwise it submits the input. Distinct
 * from the emergency KILL — cancel never latches, never disables the input.
 */
export function primaryAction(status: AgentStatus): 'send' | 'stop' {
  return status === 'thinking' || status === 'tool' ? 'stop' : 'send';
}
