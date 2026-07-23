/**
 * GraphCard — a live, Obsidian-style knowledge graph (Phase 3).
 *
 * Data: alfred.getGraph() (notes + projects + wikilink/backlink edges), refetched
 * on mount and whenever the agent finishes a turn (memory/projects may have moved).
 *
 * Live activity (ZERO AI cost, NO new tools): subscribes to the SAME tool.start/
 * tool.end StreamEvents the rest of the UI already gets, maps their args to a node
 * (graph-pure.toolEventTarget/resolveActivity) and lights it — cyan pulse = read,
 * amber = write, green flash = ok, red = error/denied. A touched file/url that is
 * not in the graph appears as a TRANSIENT amber node that fades after the activity,
 * with a PIN action to keep it.
 *
 * Render: a hand-rolled force-directed simulation on <canvas> (no graph library),
 * alpha-decayed so it settles and stops doing physics; the render loop stays cheap
 * (it only animates highlight pulses). Zoom (wheel), pan (drag background) and node
 * drag are supported.
 *
 * Interactions: (A) click a node → highlight it + its links, dim the rest; (B) a
 * read-only Markdown preview of the note inside the card; (D) a Reference button
 * (in the panel, never the click) → openReference(target,title) from Phase 2.
 */
import { useEffect, useRef, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { Markdown } from './Markdown.tsx';
import {
  toolEventTarget,
  resolveActivity,
  activityIntensity,
  type Graph,
  type GraphNode,
} from '../../main/core/graph-pure.ts';
import type { StreamEvent } from '../../main/core/types.ts';
import type { ReferenceTarget } from '../../main/core/reference.ts';

type NodeType = GraphNode['type'] | 'file' | 'url';
interface SimNode {
  id: string;
  label: string;
  type: NodeType;
  slug?: string;
  transient: boolean;
}
interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
type Status = 'read' | 'write' | 'ok' | 'error' | 'denied';
interface Activity {
  status: Status;
  ts: number;
}

const COLOR: Record<NodeType, string> = {
  note: '#35e5ff',
  project: '#ff3ec9',
  file: '#ffb020',
  url: '#ffb020',
};
const STATUS_COLOR: Record<Status, string> = {
  read: '#35e5ff',
  write: '#ffb020',
  ok: '#b8ff3a',
  error: '#ff3b52',
  denied: '#ff3b52',
};
const radiusFor = (t: NodeType): number => (t === 'project' ? 11 : t === 'note' ? 7 : 6);

export function GraphCard({ onReference }: { onReference: (target: ReferenceTarget, title?: string) => void }) {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; markdown: string } | null>(null);
  const [, forceRender] = useState(0); // bump to reflect transient/pin changes in the panel

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Simulation + live state live in refs so the rAF loop never restarts on render.
  const graphRef = useRef<Graph>(graph);
  const transientsRef = useRef<Map<string, SimNode>>(new Map());
  const pinnedRef = useRef<Set<string>>(new Set());
  const posRef = useRef<Map<string, Pos>>(new Map());
  const activityRef = useRef<Map<string, Activity>>(new Map());
  const lastActiveRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const view = useRef({ scale: 1, tx: 0, ty: 0, inited: false });
  const alphaRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });

  graphRef.current = graph;
  selectedRef.current = selected;

  const allNodes = (): SimNode[] => {
    const g = graphRef.current.nodes.map(
      (n): SimNode => ({ id: n.id, label: n.label, type: n.type, slug: n.slug, transient: false }),
    );
    return g.concat([...transientsRef.current.values()]);
  };
  const nodeById = (id: string): SimNode | undefined => allNodes().find((n) => n.id === id);

  const seed = (id: string): Pos => {
    const s = sizeRef.current;
    const p: Pos = {
      x: s.w / 2 + (Math.random() - 0.5) * 160,
      y: s.h / 2 + (Math.random() - 0.5) * 160,
      vx: 0,
      vy: 0,
    };
    posRef.current.set(id, p);
    return p;
  };
  const kick = (): void => {
    alphaRef.current = Math.max(alphaRef.current, 0.5);
  };

  // ── data: fetch graph on mount + when a turn completes ──────────────────────
  useEffect(() => {
    const refetch = (): void => {
      alfred
        .getGraph()
        .then((g) => {
          setGraph(g);
          kick();
        })
        .catch(() => {});
    };
    refetch();
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'agent.status' && (e.status === 'done' || e.status === 'idle')) refetch();
      else if (e.kind === 'tool.start') onToolStart(e.toolName, e.args);
      else if (e.kind === 'tool.end') onToolEnd(e.status);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onToolStart = (toolName: string, args: unknown): void => {
    const target = toolEventTarget(toolName, args);
    if (!target) return;
    const r = resolveActivity(graphRef.current.nodes, target);
    if (r.transient && !transientsRef.current.has(r.id)) {
      transientsRef.current.set(r.id, {
        id: r.id,
        label: r.label,
        type: r.kind as NodeType,
        transient: true,
      });
      seed(r.id);
      forceRender((n) => n + 1);
    }
    activityRef.current.set(r.id, { status: r.write ? 'write' : 'read', ts: Date.now() });
    lastActiveRef.current = r.id;
    kick();
  };

  const onToolEnd = (status: string): void => {
    const id = lastActiveRef.current;
    if (!id) return;
    const s: Status = status === 'ok' ? 'ok' : status === 'denied' ? 'denied' : status === 'error' || status === 'blocked' ? 'error' : 'ok';
    activityRef.current.set(id, { status: s, ts: Date.now() });
  };

  // ── seed positions for newly-arrived graph nodes ────────────────────────────
  useEffect(() => {
    for (const n of graph.nodes) if (!posRef.current.has(n.id)) seed(n.id);
    // Drop stale positions/activity for nodes no longer present (keep transients).
    const live = new Set(graph.nodes.map((n) => n.id));
    for (const id of [...posRef.current.keys()]) {
      if (!live.has(id) && !transientsRef.current.has(id)) posRef.current.delete(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // ── canvas size (DPR-aware) ─────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const measure = (): void => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      sizeRef.current = { w, h };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!view.current.inited && w && h) {
        view.current = { scale: 1, tx: 0, ty: 0, inited: true };
      }
      kick();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // ── simulation + render loop ────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const tick = (): void => {
      const nodes = allNodes();
      const pos = posRef.current;
      for (const n of nodes) if (!pos.has(n.id)) seed(n.id);
      const { w, h } = sizeRef.current;

      // Physics only while there's energy to spend (alpha-decayed). O(n²) repulsion —
      // ponytail: fine for a personal vault (dozens–hundreds of notes); swap for a
      // quadtree/Barnes-Hut only if a vault ever makes this the bottleneck.
      const alpha = alphaRef.current;
      if (alpha > 0.02 && w && h) {
        for (let i = 0; i < nodes.length; i++) {
          const a = pos.get(nodes[i].id)!;
          for (let j = i + 1; j < nodes.length; j++) {
            const b = pos.get(nodes[j].id)!;
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 0.01;
            }
            const f = (1800 / d2) * alpha;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
          }
          // gravity toward centre
          a.vx += (w / 2 - a.x) * 0.006 * alpha;
          a.vy += (h / 2 - a.y) * 0.006 * alpha;
        }
        for (const e of graphRef.current.edges) {
          const a = pos.get(e.source);
          const b = pos.get(e.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (d - 96) * 0.02 * alpha;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
        for (const n of nodes) {
          const p = pos.get(n.id)!;
          if (dragRef.current?.id === n.id) continue; // pinned to cursor
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.82;
          p.vy *= 0.82;
        }
        alphaRef.current = alpha * 0.985;
      }

      // Expire faded transient nodes (unless pinned).
      const now = Date.now();
      for (const id of [...transientsRef.current.keys()]) {
        const act = activityRef.current.get(id);
        const inten = act ? activityIntensity(now - act.ts) : 0;
        if (inten <= 0 && !pinnedRef.current.has(id)) {
          transientsRef.current.delete(id);
          posRef.current.delete(id);
          activityRef.current.delete(id);
          if (selectedRef.current === id) {
            setSelected(null);
            setPreview(null);
          }
        }
      }

      draw(ctx);
      raf = requestAnimationFrame(tick);
    };

    const draw = (c: CanvasRenderingContext2D): void => {
      const { w, h } = sizeRef.current;
      const { scale, tx, ty } = view.current;
      c.clearRect(0, 0, w, h);
      c.save();
      c.translate(tx, ty);
      c.scale(scale, scale);

      const pos = posRef.current;
      const nodes = allNodes();
      const sel = selectedRef.current;
      const neigh = new Set<string>();
      if (sel) {
        neigh.add(sel);
        for (const e of graphRef.current.edges) {
          if (e.source === sel) neigh.add(e.target);
          if (e.target === sel) neigh.add(e.source);
        }
      }
      const dim = (id: string): number => (!sel || neigh.has(id) ? 1 : 0.16);
      const now = Date.now();

      // edges
      for (const e of graphRef.current.edges) {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) continue;
        const on = !sel || (neigh.has(e.source) && neigh.has(e.target));
        c.strokeStyle = e.type === 'belongs' ? `rgba(255,62,201,${on ? 0.5 : 0.08})` : `rgba(53,229,255,${on ? 0.32 : 0.06})`;
        c.lineWidth = (on && sel ? 1.6 : 0.8) / scale;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }

      // nodes
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        const r = radiusFor(n.type);
        const base = COLOR[n.type];
        const alpha = dim(n.id);
        const act = activityRef.current.get(n.id);
        const inten = act ? activityIntensity(now - act.ts) : 0;

        // live status ring / pulse
        if (inten > 0 && act) {
          const sc = STATUS_COLOR[act.status];
          const pulse = act.status === 'read' ? 1 + 0.4 * Math.sin(now / 140) : 1.25;
          c.beginPath();
          c.arc(p.x, p.y, r + 6 * inten * pulse, 0, Math.PI * 2);
          c.strokeStyle = withAlpha(sc, 0.7 * inten);
          c.lineWidth = 2 / scale;
          c.stroke();
          c.shadowColor = sc;
          c.shadowBlur = 18 * inten;
        } else {
          c.shadowColor = base;
          c.shadowBlur = n.id === sel ? 16 : 7;
        }

        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fillStyle = withAlpha(inten > 0 && act ? STATUS_COLOR[act.status] : base, alpha);
        c.fill();
        c.shadowBlur = 0;
        if (n.transient) {
          c.strokeStyle = withAlpha('#ffb020', alpha);
          c.setLineDash([3 / scale, 3 / scale]);
          c.lineWidth = 1.2 / scale;
          c.stroke();
          c.setLineDash([]);
        }
        if (n.id === sel) {
          c.strokeStyle = '#ffffff';
          c.lineWidth = 1.5 / scale;
          c.stroke();
        }

        // labels: only for selected+neighbours and active nodes (avoid clutter)
        if ((sel && neigh.has(n.id)) || inten > 0.4) {
          c.fillStyle = withAlpha('#cbe4f2', Math.max(alpha, inten));
          c.font = `${11 / scale}px ui-monospace, monospace`;
          c.textAlign = 'center';
          c.fillText(n.label.slice(0, 28), p.x, p.y + r + 12 / scale);
        }
      }
      c.restore();
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── pointer: pan / node-drag / click-select / wheel-zoom ─────────────────────
  const dragRef = useRef<{ id: string | null; x0: number; y0: number; moved: boolean } | null>(null);

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { scale, tx, ty } = view.current;
    return { x: (clientX - rect.left - tx) / scale, y: (clientY - rect.top - ty) / scale };
  };
  const hit = (wx: number, wy: number): SimNode | null => {
    const pos = posRef.current;
    for (const n of allNodes()) {
      const p = pos.get(n.id);
      if (!p) continue;
      const r = radiusFor(n.type) + 6;
      if ((p.x - wx) ** 2 + (p.y - wy) ** 2 <= r * r) return n;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const wp = toWorld(e.clientX, e.clientY);
    const node = hit(wp.x, wp.y);
    dragRef.current = { id: node?.id ?? null, x0: e.clientX, y0: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 4) d.moved = true;
    if (d.id) {
      const wp = toWorld(e.clientX, e.clientY);
      const p = posRef.current.get(d.id);
      if (p) {
        p.x = wp.x;
        p.y = wp.y;
        p.vx = 0;
        p.vy = 0;
      }
      kick();
    } else {
      view.current.tx += e.movementX;
      view.current.ty += e.movementY;
    }
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      // a click, not a drag → select / deselect
      const wp = toWorld(e.clientX, e.clientY);
      const node = hit(wp.x, wp.y);
      if (node) selectNode(node);
      else {
        setSelected(null);
        setPreview(null);
      }
    }
  };
  const onWheel = (e: React.WheelEvent): void => {
    const wp = toWorld(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const v = view.current;
    const next = Math.min(4, Math.max(0.25, v.scale * factor));
    // keep the point under the cursor stationary
    const rect = canvasRef.current!.getBoundingClientRect();
    v.tx = e.clientX - rect.left - wp.x * next;
    v.ty = e.clientY - rect.top - wp.y * next;
    v.scale = next;
  };

  const selectNode = (node: SimNode): void => {
    setSelected(node.id);
    if (node.type === 'note' && node.slug) {
      setPreview(null);
      alfred
        .getNote(node.slug)
        .then((n) => setPreview(n))
        .catch(() => setPreview(null));
    } else {
      setPreview(null);
    }
  };

  const selNode = selected ? nodeById(selected) : undefined;
  const isPinned = selNode?.transient && pinnedRef.current.has(selNode.id);

  const doReference = (): void => {
    if (!selNode) return;
    if (selNode.type === 'note' && selNode.slug) onReference({ note: selNode.slug }, selNode.label);
    else if (selNode.type === 'project' && selNode.slug) onReference({ project: selNode.slug }, selNode.label);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        className="no-drag"
        style={{ position: 'absolute', inset: 0, cursor: 'grab', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      />

      {graph.nodes.length === 0 && (
        <div className="empty" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          NO NOTES YET
        </div>
      )}

      {/* legend */}
      <div
        style={{
          position: 'absolute',
          left: 8,
          bottom: 8,
          display: 'flex',
          gap: 10,
          fontSize: 10,
          color: 'var(--dim)',
          pointerEvents: 'none',
        }}
      >
        <Dot c="#35e5ff" /> note <Dot c="#ff3ec9" /> project <Dot c="#ffb020" /> live file
      </div>

      {/* selected-node panel: preview (B) + Reference (D) + pin (transient) */}
      {selNode && (
        <div
          className="no-drag"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 'min(300px, 70%)',
            maxHeight: 'calc(100% - 16px)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--panel, rgba(9,14,24,0.92))',
            border: `1px solid ${COLOR[selNode.type]}`,
            borderRadius: 10,
            boxShadow: `0 0 24px -8px ${COLOR[selNode.type]}`,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <span style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase' }}>{selNode.type}</span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selNode.label}
            </span>
            <button
              type="button"
              className="no-drag"
              title="Close"
              onClick={() => {
                setSelected(null);
                setPreview(null);
              }}
              style={panelBtn}
            >
              ✕
            </button>
          </div>

          {(preview || selNode.type === 'note') && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 10px', fontSize: 12 }}>
              {preview ? <Markdown content={preview.markdown} /> : <span style={{ color: 'var(--dim)' }}>loading…</span>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {(selNode.type === 'note' || selNode.type === 'project') && (
              <button type="button" className="no-drag" onClick={doReference} style={{ ...panelBtn, borderColor: 'var(--cyan)', color: 'var(--cyan)' }}>
                ◈ Reference
              </button>
            )}
            {selNode.transient && (
              <button
                type="button"
                className="no-drag"
                onClick={() => {
                  if (pinnedRef.current.has(selNode.id)) pinnedRef.current.delete(selNode.id);
                  else pinnedRef.current.add(selNode.id);
                  forceRender((n) => n + 1);
                }}
                style={{ ...panelBtn, borderColor: 'var(--amber)', color: 'var(--amber)' }}
              >
                {isPinned ? '📌 Pinned' : '📌 Pin'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const panelBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 6,
  color: 'var(--dim)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
  padding: '3px 8px',
};

function Dot({ c }: { c: string }) {
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 6px ${c}`, display: 'inline-block' }} />;
}

/** Add an alpha to a #rrggbb colour → rgba(). */
function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
