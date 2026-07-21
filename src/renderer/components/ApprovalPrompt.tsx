/**
 * ApprovalPrompt — HITL gate for T2/T3 actions. Blocks the agent until the
 * user approves or denies (timeout upstream fails safe to deny).
 * App-driven (not renderable via render_ui). Theme tokens: see Panel.tsx.
 */
import type { ApprovalDecision, ApprovalRequest } from '../../main/core/types.ts';

const TIER_COLOR: Record<string, string> = {
  T2: 'var(--neon-amber, #fbbf24)',
  T3: 'var(--neon-red, #f87171)',
};

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  onResolve: (id: string, decision: ApprovalDecision) => void;
}

export function ApprovalPrompt({ request, onResolve }: ApprovalPromptProps) {
  const color = TIER_COLOR[request.tier] ?? 'var(--neon-amber, #fbbf24)';
  return (
    <div
      className="alfred-approval"
      role="alertdialog"
      aria-label={`Approval required for ${request.toolName}`}
      style={{
        background: 'var(--panel, #0e1420)',
        border: `1px solid ${color}`,
        borderRadius: 8,
        boxShadow: `0 0 16px -6px ${color}`,
        padding: 16,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span
          style={{
            color,
            border: `1px solid ${color}`,
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {request.tier}
        </span>
        <span style={{ color: 'var(--text, #e5eef7)', fontWeight: 600 }}>{request.toolName}</span>
        <span style={{ color: 'var(--text-dim, #7c8ba1)', marginLeft: 'auto', fontSize: 11 }}>
          approval required
        </span>
      </div>

      <p style={{ color: 'var(--text, #e5eef7)', fontSize: 13, margin: '0 0 10px' }}>{request.reason}</p>

      <pre
        style={{
          background: 'var(--panel-2, #131b2b)',
          border: '1px solid var(--border, #1e2a3a)',
          borderRadius: 6,
          padding: 10,
          fontSize: 12,
          color: 'var(--text-dim, #7c8ba1)',
          overflowX: 'auto',
          margin: '0 0 12px',
        }}
      >
        {JSON.stringify(request.args, null, 2)}
      </pre>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => onResolve(request.id, 'deny')}
          style={{
            background: 'transparent',
            border: '1px solid var(--neon-red, #f87171)',
            color: 'var(--neon-red, #f87171)',
            borderRadius: 6,
            padding: '6px 16px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onResolve(request.id, 'approve')}
          style={{
            background: 'var(--neon-green, #34d399)',
            border: '1px solid var(--neon-green, #34d399)',
            color: 'var(--bg, #080c14)',
            borderRadius: 6,
            padding: '6px 16px',
            cursor: 'pointer',
            fontWeight: 700,
            fontFamily: 'inherit',
          }}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
