/**
 * A floating, draggable, resizable card. Positioned absolutely from the layout
 * store; dragged by its header, resized from the bottom-right corner or the
 * right/bottom edges, brought to the front on any pointer-down. Local box state
 * gives smooth 60fps drags; on
 * release it persists via onChange. When the store pushes a new position (e.g.
 * the AI moved this card) and we're not mid-drag, we resync.
 *
 * Drag is rect-based, not delta-based: on pointerdown we measure the real card
 * and canvas rects (getBoundingClientRect) and remember where inside the card
 * the cursor grabbed. On move the new position is `cursor - grabOffset -
 * canvasOrigin`, so the card follows the cursor exactly regardless of the
 * canvas's own offset (the .app padding, header chrome, etc.) — no jump — and
 * every position is clamped on-screen. No external drag library.
 */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { CardLayout, CardPatch } from '../../main/core/types.ts';
import { clampBox, MIN_W, MIN_H } from '../../main/core/layout.ts';

interface Props {
  card: CardLayout;
  meta?: ReactNode;
  onChange: (patch: CardPatch) => void;
  onFocus: () => void;
  onHide: () => void;
  children: ReactNode;
}

interface DragState {
  mode: 'move' | 'resize';
  /** Which dimensions this resize edits ('both' = corner, 'x' = right edge, 'y' = bottom edge). */
  dir: 'both' | 'x' | 'y';
  /** Cursor offset inside the card at grab time (move). */
  grabDX: number;
  grabDY: number;
  /** Card's viewport top-left at grab time (resize). */
  cardLeft: number;
  cardTop: number;
  /** Canvas rect at grab time — the coordinate origin + clamp bounds. */
  canvasLeft: number;
  canvasTop: number;
  canvasW: number;
  canvasH: number;
}

export function DraggableCard({ card, meta, onChange, onFocus, onHide, children }: Props) {
  const [box, setBox] = useState({ x: card.x, y: card.y, w: card.w, h: card.h });
  const boxRef = useRef(box);
  boxRef.current = box;
  const drag = useRef<DragState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Resync to the store when it changes underneath us (AI move, other window)
  // — but never while the user is actively dragging this card (drag ref set).
  useEffect(() => {
    if (!drag.current) setBox({ x: card.x, y: card.y, w: card.w, h: card.h });
  }, [card.x, card.y, card.w, card.h]);

  const start = (mode: 'move' | 'resize', dir: 'both' | 'x' | 'y' = 'both') => (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // let header buttons work
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const cardRect = root.getBoundingClientRect();
    // Cards live directly inside .canvas; its rect is the coordinate origin.
    const canvas = (root.parentElement ?? root).getBoundingClientRect();
    drag.current = {
      mode,
      dir,
      grabDX: e.clientX - cardRect.left,
      grabDY: e.clientY - cardRect.top,
      cardLeft: cardRect.left,
      cardTop: cardRect.top,
      canvasLeft: canvas.left,
      canvasTop: canvas.top,
      canvasW: canvas.width,
      canvasH: canvas.height,
    };
    root.setPointerCapture(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const bounds = { w: d.canvasW, h: d.canvasH };
    if (d.mode === 'move') {
      const x = e.clientX - d.grabDX - d.canvasLeft;
      const y = e.clientY - d.grabDY - d.canvasTop;
      setBox((b) => ({ ...b, ...clampBox({ x, y, w: b.w, h: b.h }, bounds) }));
    } else {
      // Resize from the card's fixed top-left; clamp so it never exits the canvas.
      // `dir` restricts editing to the grabbed axis (right edge = width only, etc.).
      setBox((b) => {
        const w =
          d.dir === 'y'
            ? b.w
            : Math.round(Math.min(Math.max(MIN_W, e.clientX - d.cardLeft), Math.max(MIN_W, d.canvasW - b.x)));
        const h =
          d.dir === 'x'
            ? b.h
            : Math.round(Math.min(Math.max(MIN_H, e.clientY - d.cardTop), Math.max(MIN_H, d.canvasH - b.y)));
        return { ...b, w, h };
      });
    }
  };

  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      rootRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    const b = boxRef.current;
    onChange(d.mode === 'move' ? { x: b.x, y: b.y } : { w: b.w, h: b.h });
  };

  return (
    <div
      ref={rootRef}
      className="dcard panel"
      // position:absolute inline so it always wins over .panel's position:relative.
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, zIndex: card.z }}
      onPointerDownCapture={() => onFocus()}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <div className="dcard-head" onPointerDown={start('move')}>
        <div className="panel-title">
          <span className="dot" />
          {card.title}
        </div>
        <div className="dcard-head-right">
          {meta}
          <button type="button" className="dcard-hide no-drag" title="Hide card" onClick={onHide}>
            ✕
          </button>
        </div>
      </div>
      <div className="dcard-body">{children}</div>
      <div className="dcard-resize-edge right no-drag" onPointerDown={start('resize', 'x')} title="Resize width" />
      <div className="dcard-resize-edge bottom no-drag" onPointerDown={start('resize', 'y')} title="Resize height" />
      <div className="dcard-resize no-drag" onPointerDown={start('resize', 'both')} title="Resize" />
    </div>
  );
}
