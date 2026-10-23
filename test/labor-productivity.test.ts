import { describe, expect, it } from 'vitest';
import type { LaborEntry } from '../src/modules/production/labor.js';
import { directHours, earnedHours, group } from '../src/modules/production/labor.js';

/** Labor productivity (D-166): direct labor hours, earned hours, output per direct labor hour and efficiency. */
const H = 3_600_000;
const t0 = Date.UTC(2026, 9, 5, 6);
const e = (x: Partial<LaborEntry> & { id: string }): LaborEntry => ({ employee: 'ana', part: 'HSG-100', workCenter: 'VMC', kind: 'run', operationId: 'op10', startedAt: t0, endedAt: t0 + H,
  good: 0, stdRunMinutes: 6, stdSetupMinutes: 30, lastOp: true, ...x });

describe('direct labor hours', () => {
  it('counts each person-hour once: two machines run at once share the overlap', () => {
    const d = directHours([e({ id: 'a', endedAt: t0 + 2 * H }), e({ id: 'b', startedAt: t0 + H, endedAt: t0 + 3 * H, operationId: 'op20' })]);
    // 0-1 h a alone, 1-2 h shared, 2-3 h b alone: 1.5 h each, 3 h in all (not 4).
    expect(d.get('a')).toBeCloseTo(1.5, 9);
    expect(d.get('b')).toBeCloseTo(1.5, 9);
  });
  it('different people at the same time are counted separately', () => {
    const d = directHours([e({ id: 'a' }), e({ id: 'b', employee: 'ben' })]);
    expect([d.get('a'), d.get('b')]).toEqual([1, 1]);
  });
});

describe('earned hours, output and efficiency', () => {
  it('earns standard run time on good units and shares a setup among its entries; scrap earns nothing', () => {
    const list = [e({ id: 's1', kind: 'setup', endedAt: t0 + H / 2 }), e({ id: 's2', kind: 'setup', employee: 'ben', endedAt: t0 + H / 2 }), e({ id: 'r', good: 10, startedAt: t0 + H, endedAt: t0 + 2 * H })];
    const earned = earnedHours(list);
    expect(earned.get('s1')).toBeCloseTo(0.25, 9); // 30 standard minutes shared by two setups
    expect(earned.get('r')).toBeCloseTo(1, 9); // 10 good × 6 min
  });
  it('output per direct labor hour counts finished units at the last operation against every direct hour on the part', () => {
    const list = [
      e({ id: 'op10', operationId: 'op10', lastOp: false, good: 20, stdRunMinutes: 3 }), // 1 h, earns 1 h
      e({ id: 'op20', operationId: 'op20', lastOp: true, good: 18, stdRunMinutes: 4, startedAt: t0 + H, endedAt: t0 + 2 * H }), // 1 h, earns 1.2 h
    ];
    const [part] = group(list, (x) => x.part);
    expect(part).toMatchObject({ key: 'HSG-100', directHours: 2, earnedHours: 2.2, finished: 18, efficiency: 1.1, unitsPerHour: 9 });
    expect(part!.standardUnitsPerHour).toBeCloseTo(8.18, 2); // 18 finished ÷ 2.2 standard hours
  });
  it('efficiency below standard shows as under 100%, by operator', () => {
    const list = [e({ id: 'a', good: 5 }), e({ id: 'b', employee: 'ben', good: 12 })];
    const rows = group(list, (x) => x.employee);
    expect(rows.find((r) => r.key === 'ana')!.efficiency).toBe(0.5);
    expect(rows.find((r) => r.key === 'ben')!.efficiency).toBe(1.2);
  });
});
