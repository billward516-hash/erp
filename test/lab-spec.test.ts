import { describe, expect, it } from 'vitest';
import { evaluate, limitText } from '../src/modules/lab/spec.js';

describe('specification evaluation (D-184D)', () => {
  it('two-sided limits are inclusive', () => {
    expect(evaluate(6.5, 6.5, 7.5)).toBe('pass');
    expect(evaluate(7.5, 6.5, 7.5)).toBe('pass');
    expect(evaluate(7.0, 6.5, 7.5)).toBe('pass');
    expect(evaluate(6.49, 6.5, 7.5)).toBe('fail');
    expect(evaluate(7.51, 6.5, 7.5)).toBe('fail');
  });

  it('one-sided limits check only the side that exists', () => {
    expect(evaluate(98, 98, null)).toBe('pass');
    expect(evaluate(250, 98, null)).toBe('pass');
    expect(evaluate(97.9, 98, null)).toBe('fail');
    expect(evaluate(2, null, 2)).toBe('pass');
    expect(evaluate(-5, null, 2)).toBe('pass');
    expect(evaluate(2.01, null, 2)).toBe('fail');
  });

  it('database numerics arrive as strings and a zero limit is a limit', () => {
    expect(evaluate(0.4, '0.5', null)).toBe('fail');
    expect(evaluate(0, null, '0')).toBe('pass');
    expect(evaluate(0.1, null, '0')).toBe('fail');
    expect(evaluate(-0.1, '0', null)).toBe('fail');
  });

  it('an analyte with no limits is reported, not passed or failed', () => {
    expect(evaluate(123, null, null)).toBe('reported');
    expect(() => evaluate(Number.NaN, 1, 2)).toThrow();
  });

  it('prints the limits the way a certificate shows them', () => {
    expect(limitText(98, null)).toBe('at least 98');
    expect(limitText(null, 2)).toBe('at most 2');
    expect(limitText('6.5', '7.5')).toBe('6.5 to 7.5');
    expect(limitText(0, null)).toBe('at least 0');
    expect(limitText(null, null)).toBe('no limit');
  });
});
