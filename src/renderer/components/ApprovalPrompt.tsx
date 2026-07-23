/**
 * ApprovalPrompt — HITL gate for T2/T3 actions. Blocks the agent until the
 * user approves or denies (timeout upstream fails safe to deny).
 * App-driven (not renderable via render_ui). Theme tokens: see Panel.tsx.
 */
import type { ApprovalDecision, ApprovalRequest } from '../../main/core/types.ts';

// Tier → accent colour + human risk label (ported from the design canvas header
// "⚠ APROVAÇÃO · … · RISCO …"). T2 = write/medium (amber), T3 = high (red).
const TIER_META: Record<string, { color: string; risk: string }> = {
  T2: { color: 'var(--amb, #ffb45e)', risk: 'MÉDIO' },
  T3: { color: 'var(--red, #ff5f6e)', risk: 'ALTO' },
};

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  onResolve: (id: string, decision: ApprovalDecision, remember?: boolean) => void;
}

export function ApprovalPrompt({ request, onResolve }: ApprovalPromptProps) {
  const meta = TIER_META[request.tier] ?? TIER_META.T2;
  const color = meta.color;
  return (
    <div
      className="alfred-approval"
      role="alertdialog"
      aria-label={`Approval required for ${request.toolName}`}
      style={{
        minWidth: 'min(520px, 90vw)',
        background: 'var(--glass)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: `1px solid ${color}`,
        borderRadius: 3,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 44px -6px ${color}`,
        padding: 16,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          color,
          marginBottom: 10,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <span>⚠ APROVAÇÃO · {request.tier} · RISCO {meta.risk}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--dim, #5b7a8a)' }}>{request.toolName}</span>
      </div>

      <p style={{ color: 'var(--text, #cfe8f2)', fontSize: 13, margin: '0 0 10px' }}>{request.reason}</p>

      <pre
        style={{
          background: 'var(--panel-2, rgba(0,0,0,0.35))',
          border: '1px solid var(--border)',
          borderRadius: 2,
          padding: 10,
          fontSize: 12,
          color: 'var(--dim, #5b7a8a)',
          overflowX: 'auto',
          margin: '0 0 12px',
        }}
      >
        {JSON.stringify(request.args, null, 2)}
      </pre>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => onResolve(request.id, 'deny')}
          style={{
            background: 'transparent',
            border: '1px solid color-mix(in oklab, var(--red) 60%, transparent)',
            color: 'var(--red, #ff5f6e)',
            borderRadius: 2,
            padding: '6px 16px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 11,
            letterSpacing: '0.12em',
          }}
        >
          RECUSAR
        </button>
        <button
          type="button"
          title="Aprovar agora e auto-aprovar esta ação a partir de agora (sem mais pedidos para ela)"
          onClick={() => onResolve(request.id, 'approve', true)}
          style={{
            background: 'transparent',
            border: '1px solid var(--grn, #4dffa6)',
            color: 'var(--grn, #4dffa6)',
            borderRadius: 2,
            padding: '6px 16px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 11,
            letterSpacing: '0.12em',
          }}
        >
          APROVAR SEMPRE
        </button>
        <button
          type="button"
          onClick={() => onResolve(request.id, 'approve')}
          style={{
            background: 'color-mix(in oklab, var(--grn) 15%, transparent)',
            border: '1px solid var(--grn, #4dffa6)',
            color: 'var(--grn, #4dffa6)',
            borderRadius: 2,
            padding: '6px 16px',
            cursor: 'pointer',
            fontWeight: 700,
            fontFamily: 'inherit',
            fontSize: 11,
            letterSpacing: '0.12em',
          }}
        >
          APROVAR
        </button>
      </div>
    </div>
  );
}
