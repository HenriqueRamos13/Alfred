/**
 * Markdown — minimal, dependency-free renderer for AI-produced text.
 * Builds React nodes directly (never dangerouslySetInnerHTML) so untrusted
 * content cannot inject markup. Supports: #/##/### headings, - / * and 1. lists,
 * ``` fenced code, blockquotes, and inline **bold** *italic* `code` [text](url).
 * ponytail: intentionally partial CommonMark; swap for `marked` if we ever need tables/nesting.
 * Theme tokens: see Panel.tsx.
 */
import { type ReactNode, createElement } from 'react';

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/**
 * Only allow http/https/mailto link targets. Markdown here can be derived from
 * untrusted web/email content, so a `javascript:`/`data:` href must never reach
 * an <a> in this Electron renderer. Returns the URL when safe, else null.
 */
function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`'))
      return (
        <code key={i} style={{ background: 'var(--panel-2, #131b2b)', padding: '1px 5px', borderRadius: 4 }}>
          {part.slice(1, -1)}
        </code>
      );
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      // Unsafe scheme (javascript:, data:, …) → render the label as plain text.
      if (!href) return link[1];
      return (
        <a key={i} href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--neon-cyan, #22d3ee)' }}>
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

export interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  const blocks: ReactNode[] = [];
  const lines = content.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          style={{
            background: 'var(--panel-2, #131b2b)',
            border: '1px solid var(--border, #1e2a3a)',
            borderRadius: 6,
            padding: 12,
            overflowX: 'auto',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 12,
          }}
        >
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(createElement(`h${h[1].length}`, { key: key++ }, inline(h[2])));
      i++;
      continue;
    }

    // lists (consecutive - / * / 1. lines)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>);
        i++;
      }
      blocks.push(createElement(ordered ? 'ol' : 'ul', { key: key++, style: { margin: '6px 0', paddingLeft: 22 } }, items));
      continue;
    }

    // blockquote
    if (line.startsWith('>')) {
      blocks.push(
        <blockquote
          key={key++}
          style={{ borderLeft: '3px solid var(--neon-magenta, #e879f9)', margin: '6px 0', paddingLeft: 12, color: 'var(--text-dim, #7c8ba1)' }}
        >
          {inline(line.replace(/^>\s?/, ''))}
        </blockquote>,
      );
      i++;
      continue;
    }

    // blank
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph (gather until blank / block start)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    blocks.push(
      <p key={key++} style={{ margin: '6px 0' }}>
        {inline(buf.join(' '))}
      </p>,
    );
  }

  return (
    <div className="alfred-markdown" style={{ color: 'var(--text, #e5eef7)', lineHeight: 1.5 }}>
      {blocks}
    </div>
  );
}
