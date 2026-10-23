/**
 * Line-by-line comparison of two revisions (D-170): the longest common subsequence of lines, shown as unchanged,
 * removed and added lines. Capped so a huge file cannot stall the server; beyond the cap only the head is compared.
 */
export interface DiffLine { op: 'same' | 'add' | 'del'; text: string }
export const DIFF_MAX_LINES = 2500;

export function diffLines(a: string[], b: string[]): { lines: DiffLine[]; truncated: boolean; added: number; removed: number } {
  const truncated = a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES;
  const x = a.slice(0, DIFF_MAX_LINES); const y = b.slice(0, DIFF_MAX_LINES);
  // Trim the common head and tail so a small change in a long document costs little.
  let head = 0; while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0; while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const mx = x.slice(head, x.length - tail); const my = y.slice(head, y.length - tail);
  const n = mx.length; const m = my.length;
  const w = m + 1; const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = mx[i] === my[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const mid: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (mx[i] === my[j]) { mid.push({ op: 'same', text: mx[i]! }); i++; j++; }
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) mid.push({ op: 'del', text: mx[i++]! });
    else mid.push({ op: 'add', text: my[j++]! });
  }
  while (i < n) mid.push({ op: 'del', text: mx[i++]! });
  while (j < m) mid.push({ op: 'add', text: my[j++]! });
  const lines = [...x.slice(0, head).map((text) => ({ op: 'same' as const, text })), ...mid, ...x.slice(x.length - tail).map((text) => ({ op: 'same' as const, text }))];
  return { lines, truncated, added: lines.filter((l) => l.op === 'add').length, removed: lines.filter((l) => l.op === 'del').length };
}
