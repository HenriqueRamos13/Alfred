/**
 * DataTable — headered table for tabular AI output.
 * Theme tokens: see Panel.tsx.
 */
export interface DataTableProps {
  columns: string[];
  rows: (string | number)[][];
}

export function DataTable({ columns, rows }: DataTableProps) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        className="alfred-table"
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 13,
          color: 'var(--text, #e5eef7)',
        }}
      >
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                style={{
                  textAlign: 'left',
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--neon-cyan, #22d3ee)',
                  color: 'var(--neon-cyan, #22d3ee)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} style={{ background: r % 2 ? 'var(--panel-2, #131b2b)' : 'transparent' }}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{ padding: '6px 12px', borderBottom: '1px solid var(--border, #1e2a3a)' }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
