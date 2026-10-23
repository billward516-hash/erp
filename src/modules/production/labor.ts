/**
 * Labor productivity (D-166), from operators' production entries:
 *
 * - Direct labor hours: the time each operator spent on setup and run entries. When one person runs two machines at once,
 *   the overlapping time is split evenly between the entries, so a person-hour is never counted twice.
 * - Earned (standard) hours: good units × the operation's standard run minutes, plus the operation's standard setup
 *   minutes, shared among the setup entries of that operation in the period. Scrap earns nothing.
 * - Labor efficiency = earned hours ÷ direct labor hours. Output per direct labor hour = good units ÷ direct labor hours,
 *   meaningful within one part (units of different parts do not add up): finished units (good at the part's last
 *   operation) ÷ every direct hour spent on that part, beside the rate at standard (finished units ÷ earned hours).
 *
 * Pure: the report and the tests compute the same figures.
 */
export interface LaborEntry {
  id: string; employee: string; part: string; workCenter: string; kind: 'setup' | 'run'; operationId: string;
  startedAt: number; endedAt: number; good: number; stdRunMinutes: number; stdSetupMinutes: number; lastOp: boolean;
}
export interface LaborRow { key: string; directHours: number; earnedHours: number; finished: number; efficiency: number | null; unitsPerHour: number | null; standardUnitsPerHour: number | null }

/** Each entry's share of its operator's clock time: overlapping entries of one person split the overlap evenly. */
export function directHours(entries: LaborEntry[]): Map<string, number> {
  const out = new Map<string, number>(entries.map((e) => [e.id, 0]));
  const byPerson = new Map<string, LaborEntry[]>();
  for (const e of entries) byPerson.set(e.employee, [...(byPerson.get(e.employee) ?? []), e]);
  for (const list of byPerson.values()) {
    // Sweep the person's timeline: between consecutive boundaries, the open entries share the slice.
    const cuts = [...new Set(list.flatMap((e) => [e.startedAt, e.endedAt]))].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const [a, b] = [cuts[i]!, cuts[i + 1]!];
      const open = list.filter((e) => e.startedAt <= a && e.endedAt >= b);
      for (const e of open) out.set(e.id, out.get(e.id)! + (b - a) / 3_600_000 / open.length);
    }
  }
  return out;
}

export function earnedHours(entries: LaborEntry[]): Map<string, number> {
  const setups = new Map<string, number>();
  for (const e of entries) if (e.kind === 'setup') setups.set(e.operationId, (setups.get(e.operationId) ?? 0) + 1);
  return new Map(entries.map((e) => [e.id, e.kind === 'setup' ? e.stdSetupMinutes / 60 / setups.get(e.operationId)! : (e.good * e.stdRunMinutes) / 60]));
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Totals grouped by a key (operator, part, work center, week). */
export function group(entries: LaborEntry[], keyOf: (e: LaborEntry) => string): LaborRow[] {
  const direct = directHours(entries); const earned = earnedHours(entries);
  const by = new Map<string, { d: number; e: number; finished: number }>();
  for (const x of entries) {
    const k = keyOf(x); const g = by.get(k) ?? { d: 0, e: 0, finished: 0 };
    g.d += direct.get(x.id)!; g.e += earned.get(x.id)!; if (x.lastOp && x.kind === 'run') g.finished += x.good;
    by.set(k, g);
  }
  return [...by.entries()].map(([key, g]) => ({ key, directHours: r2(g.d), earnedHours: r2(g.e), finished: g.finished, efficiency: g.d > 0 ? Math.round((1000 * g.e) / g.d) / 1000 : null,
    unitsPerHour: g.d > 0 && g.finished ? r2(g.finished / g.d) : null, standardUnitsPerHour: g.e > 0 && g.finished ? r2(g.finished / g.e) : null }));
}
