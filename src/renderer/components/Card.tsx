/**
 * Card — plain neutral container with optional title.
 * Theme tokens: see Panel.tsx.
 */
import type { ReactNode } from 'react';

export interface CardProps {
  title?: string;
  children?: ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <div
      className="alfred-card"
      style={{
        background: 'var(--panel-2, #131b2b)',
        border: '1px solid var(--border, #1e2a3a)',
        borderRadius: 8,
        padding: 14,
        color: 'var(--text, #e5eef7)',
      }}
    >
      {title && (
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 8,
            color: 'var(--text, #e5eef7)',
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
