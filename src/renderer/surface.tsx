/**
 * Renders an AI-authored UiNode tree through the whitelisted REGISTRY.
 * Unknown components render a visible error box, never arbitrary markup.
 */
import type { ReactNode } from 'react';
import type { UiNode } from '../main/core/types.ts';
import { REGISTRY } from './registry.tsx';

function renderNode(node: UiNode, key: string): ReactNode {
  const Cmp = REGISTRY[node.component];
  if (!Cmp) {
    return (
      <div key={key} className="unknown-node">
        unknown component: {node.component}
      </div>
    );
  }
  const children = node.children?.map((child, i) => renderNode(child, `${key}.${i}`));
  return (
    <Cmp key={key} {...(node.props ?? {})}>
      {children}
    </Cmp>
  );
}

export function Surface({ tree }: { tree: UiNode | null }) {
  if (!tree) {
    return <div className="surface-empty">awaiting generative UI // render_ui</div>;
  }
  return <>{renderNode(tree, 'root')}</>;
}
