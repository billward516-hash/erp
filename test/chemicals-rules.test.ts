import { describe, expect, it } from 'vitest';
import { baseUnit, beyondUse, casValid, convertQty, earliest, olderThanYears, preparationExpiry } from '../src/modules/chemicals/rules.js';

/** The pure rules behind chemicals (SC-007 C). */
describe('beyond-use date', () => {
  it('is the opened date plus the in-use days', () => {
    expect(beyondUse('2026-03-01', 30, '2027-01-01')).toBe('2026-03-31');
    expect(beyondUse('2026-12-20', 30, null)).toBe('2027-01-19');
  });
  it('is never later than the expiry', () => {
    expect(beyondUse('2026-03-01', 30, '2026-03-10')).toBe('2026-03-10');
    expect(beyondUse('2026-03-01', 30, '2026-03-31')).toBe('2026-03-31');
  });
  it('is the expiry when the part has no in-use days, and nothing when there is neither', () => {
    expect(beyondUse('2026-03-01', null, '2026-09-01')).toBe('2026-09-01');
    expect(beyondUse('2026-03-01', null, null)).toBeNull();
  });
});

describe('preparation expiry', () => {
  it('is the earliest of the component dates and the stated shelf life', () => {
    expect(preparationExpiry('2026-03-01', 90, ['2026-12-01', '2026-04-15'])).toBe('2026-04-15');
    expect(preparationExpiry('2026-03-01', 30, ['2026-12-01', '2026-04-15'])).toBe('2026-03-31');
    expect(preparationExpiry('2026-03-01', null, ['2026-12-01', null])).toBe('2026-12-01');
    expect(preparationExpiry('2026-03-01', null, [null])).toBeNull();
    expect(earliest(null, undefined)).toBeNull();
  });
});

describe('CAS numbers', () => {
  it('check digits', () => {
    for (const ok of ['7647-01-0', '67-64-1', '7732-18-5', '64-17-5']) expect(casValid(ok)).toBe(true);
    for (const bad of ['7647-01-1', '67-64', 'acetone', '7732-18-6', '']) expect(casValid(bad)).toBe(false);
  });
});

describe('safety data sheet age', () => {
  it('a revision exactly N years old is not yet older', () => {
    expect(olderThanYears('2023-06-01', 3, '2026-06-01')).toBe(false);
    expect(olderThanYears('2023-06-01', 3, '2026-06-02')).toBe(true);
    expect(olderThanYears('2025-01-01', 3, '2026-06-02')).toBe(false);
  });
});

describe('units', () => {
  it('convert within a kind only', () => {
    expect(convertQty(2500, 'ML', 'L')).toBeCloseTo(2.5);
    expect(convertQty(1, 'GAL', 'L')).toBeCloseTo(3.785411784);
    expect(convertQty(1, 'KG', 'L')).toBeNull();
    expect(baseUnit('ml')).toBe('L');
    expect(baseUnit('lb')).toBe('KG');
    expect(baseUnit('EA')).toBe('EA');
  });
});
