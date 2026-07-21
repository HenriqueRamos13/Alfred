/**
 * A floating, draggable, resizable card. Positioned absolutely from the layout
 * store; dragged by its header, resized from the bottom-right handle, brought to
 * the front on any pointer-down. Local box state gives smooth 60fps drags; on
 * release (and on drag-end) it persists via onChange. When the store pushes a
 * new position (e.g. the AI moved this card) and we're not mid-drag, we resync.
 *
 * No external drag library — pointer events + pointer capture only.
 */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { CardLayout, CardPatch } from '../../main/core/types.ts';

const MIN_W = 220;
const MIN_H = 120;

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
  px: number;
  py: number;
  ax: number;
  ay: number;
}

export function DraggableCard({ card, meta, onChange, onFocus, onHide, children }: Props) {
  const [box, setBox] = useState({ x: card.x, y: card.y, w: card.w, h: card.h });
  const boxRef = useRef(box);
  boxRef.current = box;
  const drag = useRef<DragState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Resync to the store when it changes underneath us (AI move, other window)
  // — but never while the user is actively dragging this card.
  useEffect(() => {
    if (!drag.current) setBox({ x: card.x, y: card.y, w: card.w, h: card.h });
  }, [card.x, card.y, card.w, card.h]);

  const start = (mode: 'move' | 'resize') => (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // let header buttons work
    e.preventDefault();
    // focus already fired via onPointerDownCapture on the root
    drag.current = {
      mode,
      px: e.clientX,
      py: e.clientY,
      ax: mode === 'move' ? box.x : box.w,
      ay: mode === 'move' ? box.y : box.h,
    };
    rootRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    setBox((b) =>
      d.mode === 'move'
        ? { ...b, x: Math.max(0, d.ax + dx), y: Math.max(0, d.ay + dy) }
        : { ...b, w: Math.max(MIN_W, d.ax + dx), h: Math.max(MIN_H, d.ay + dy) },
    );
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
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: card.z }}
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
      <div className="dcard-resize" onPointerDown={start('resize')} title="Resize" />
    </div>
  );
}
