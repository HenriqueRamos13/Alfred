/**
 * PendingSend — the editable "about to send" bubble shown under the chat log
 * during the send-delay edit window. Distinct dim/dashed styling + a draining bar
 * counting down the hold. Actions: click to EDIT (freezes the countdown, inline
 * textarea; reconfirm re-arms with the edited text), ENVIAR JÁ (skip the wait),
 * × (discard without sending). Pure presentation — the parent owns the timer.
 */
import { useState } from 'react';

export interface PendingSend {
  id: string;
  text: string;
  /** Epoch ms when it auto-sends (informational; the drain bar animates over delayMs). */
  deadline: number;
}

export interface PendingSendProps {
  pending: PendingSend;
  /** Hold duration in ms — drives the drain-bar animation length. */
  delayMs: number;
  /** Send this pending message right now (skip the remaining wait). */
  onSendNow: () => void;
  /** Discard the pending message (never sent). */
  onCancel: () => void;
  /** Re-arm the pending with edited text (a fresh edit window). */
  onEdit: (text: string) => void;
  /** Entering edit mode — the parent pauses the auto-send timer. */
  onEditStart: () => void;
}

export function PendingSendBubble({ pending, delayMs, onSendNow, onCancel, onEdit, onEditStart }: PendingSendProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pending.text);

  const startEdit = () => {
    setDraft(pending.text);
    setEditing(true);
    onEditStart(); // freeze the countdown while the user edits
  };
  const confirmEdit = () => {
    setEditing(false);
    onEdit(draft); // parent re-arms a fresh window with the edited text
  };

  return (
    <div className="pending-send no-drag" aria-live="polite">
      <div className="pending-send-head">
        <span className="pending-send-tag">A ENVIAR EM {(delayMs / 1000).toFixed(delayMs % 1000 ? 1 : 0)}s</span>
        <div className="pending-send-actions">
          {!editing && (
            <button type="button" className="pending-send-btn go no-drag" onClick={onSendNow} title="Enviar já — salta a espera">
              ENVIAR JÁ
            </button>
          )}
          {editing && (
            <button type="button" className="pending-send-btn go no-drag" onClick={confirmEdit} title="Reconfirmar — re-arma a espera com o texto editado">
              RECONFIRMAR
            </button>
          )}
          <button type="button" className="pending-send-btn x no-drag" onClick={onCancel} title="Cancelar — descartar sem enviar" aria-label="Cancelar">
            ×
          </button>
        </div>
      </div>

      {editing ? (
        <textarea
          className="pending-send-edit no-drag"
          value={draft}
          autoFocus
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              confirmEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="pending-send-text no-drag"
          onClick={startEdit}
          title="Clicar para editar antes de enviar"
        >
          {pending.text}
        </button>
      )}

      {!editing && (
        // key={pending.id} restarts the CSS drain animation on each fresh pending.
        <div className="pending-send-bar">
          <div key={pending.id} className="pending-send-fill" style={{ animationDuration: `${delayMs}ms` }} />
        </div>
      )}
    </div>
  );
}
