import type { Tool, UiNode } from './types.ts';
import { AI_COMPONENTS } from '../core/types.ts';

interface Args {
  target?: string;
  tree: UiNode;
}

const ALLOWED = new Set<string>(AI_COMPONENTS);

/** Reject any node whose component is not on the whitelist. Returns the bad name or null. */
function firstDisallowed(node: UiNode): string | null {
  if (!node || typeof node.component !== 'string') return String(node?.component);
  if (!ALLOWED.has(node.component)) return node.component;
  for (const child of node.children ?? []) {
    const bad = firstDisallowed(child);
    if (bad) return bad;
  }
  return null;
}

export const renderUi: Tool<Args> = {
  name: 'render_ui',
  description:
    'Render a generative UI tree onto the control-centre surface. ' +
    `Each node is { component, props?, children? }; component must be one of: ${AI_COMPONENTS.join(', ')}. ` +
    'Follow the DESIGN LANGUAGE (see the manifest / AGENTS.md): the neon-HUD look — use the CSS vars ' +
    '(var(--acc) ciano primary, var(--amb) amber, var(--mag) magenta, var(--grn) ok, var(--red) danger) not raw hexes, ' +
    'mono for data/numbers, UPPERCASE mono labels, dark glass + neon borders, so it stays coherent with the rest of the centre.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Named surface region (optional).' },
      tree: {
        type: 'object',
        description: 'Root UiNode: { component, props?, children? }.',
        properties: {
          component: { type: 'string', enum: [...AI_COMPONENTS] },
          props: { type: 'object' },
          children: { type: 'array' },
        },
        required: ['component'],
      },
    },
    required: ['tree'],
  },

  risk: () => 'T0',

  async execute(a, ctx) {
    if (!a.tree || typeof a.tree.component !== 'string')
      return { ok: false, error: 'tree.component is required' };
    const bad = firstDisallowed(a.tree);
    if (bad) return { ok: false, error: `Component "${bad}" is not renderable` };
    ctx.sendUi({ target: a.target, tree: a.tree });
    return { ok: true, result: { rendered: true } };
  },
};
