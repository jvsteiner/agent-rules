// A clean starting point. Nothing here trips a rule.

export interface Row {
  id: string;
  label: string;
}

export function countRows(rows: Row[]): number {
  return rows.length;
}

export function findRow(rows: Row[], id: string): Row | undefined {
  return rows.find((r) => r.id === id);
}
