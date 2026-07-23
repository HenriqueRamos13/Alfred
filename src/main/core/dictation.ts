/**
 * Dictation input state machine (renderer-facing, but PURE so it is unit-testable
 * without React). Governs how voice events reach the editable command input:
 *
 *   - PARTIALS are a transient PREVIEW only ("…a ouvir: <parcial>"); they never
 *     touch the editable value.
 *   - A FINAL commits the settled text to the input exactly ONCE per activation
 *     (append is done by the CommandBar off the bumped `commit.seq`).
 *   - An "activation" starts on wake.detected or a manual mic press. After the
 *     committing final the machine is DISARMED: further partials/finals are
 *     ignored until the next activation, so a late/duplicate final can neither
 *     re-fill the box nor overwrite the user's manual edits (they stay in control;
 *     if they clear it, it stays clear).
 *   - An EMPTY final (wake heard, no command) just disarms + clears the preview —
 *     it writes nothing.
 *
 * Both the mic button and the wake word route their stt.partial/stt.final through
 * this single reducer, so the behaviour is identical for both.
 */

export interface DictationState {
  /** An activation is in progress (between wake/mic and its committing final). */
  armed: boolean;
  /** Transient partial-transcript preview (empty when not previewing). */
  preview: string;
  /**
   * The last settled transcript to write into the input. `seq` is bumped only
   * when a new final should be committed; the CommandBar appends on that change.
   */
  commit: { text: string; seq: number };
}

export type DictationEvent =
  | { kind: 'activate' } // wake.detected or mic pressed → arm + clear preview
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string };

export function initialDictation(): DictationState {
  return { armed: false, preview: '', commit: { text: '', seq: 0 } };
}

/**
 * PURE — auto-send gate. When the auto-send toggle is ON, a settled final with
 * non-empty text is submitted automatically (the user need only stop talking).
 * OFF, or an empty/whitespace final, never auto-sends.
 */
export function shouldAutoSend(enabled: boolean, finalText: string): boolean {
  return enabled && finalText.trim().length > 0;
}

/** PURE — advance the dictation state for one voice event. */
export function dictationReduce(s: DictationState, e: DictationEvent): DictationState {
  switch (e.kind) {
    case 'activate':
      return { ...s, armed: true, preview: '' };
    case 'partial':
      // Ignore partials outside an activation (stray/late) so they can't flicker
      // the preview after a commit; while armed, show the live partial.
      return s.armed ? { ...s, preview: e.text } : s;
    case 'final': {
      // Not armed → a late/duplicate final: ignore entirely (never re-fill the
      // input the user may have since edited or cleared).
      if (!s.armed) return s;
      const t = e.text.trim();
      // Empty final: disarm + clear preview, but write nothing.
      if (!t) return { ...s, armed: false, preview: '' };
      // Commit once, then disarm: the dictation won't touch the input again until
      // the next activation.
      return { armed: false, preview: '', commit: { text: t, seq: s.commit.seq + 1 } };
    }
  }
}
