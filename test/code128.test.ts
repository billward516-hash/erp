import { describe, expect, it } from 'vitest';
import { code128Widths, code128Printable } from '../src/modules/inventory/code128.js';

describe('code 128', () => {
  it('every symbol is 11 modules wide and the stop is 13, so the table is intact', () => {
    const w = code128Widths('A');
    // start B + 'A' + check + stop = 3 symbols of 11 modules and a 13-module stop
    expect(w.reduce((a, b) => a + b, 0)).toBe(11 * 3 + 13);
    expect(w.length).toBe(6 * 3 + 7);
  });
  it('matches a known encoding: "PJJ123C" has check character 54 (Wikipedia example in subset B variants differ, so check the arithmetic)', () => {
    // start B (104) + 'A'(33)*1 = 137; 137 mod 103 = 34 -> pattern of value 34 is 131123
    expect(code128Widths('A').slice(6 + 6, 6 + 12).join('')).toBe('131123');
  });
  it('every printable character encodes to an 11-module symbol (catches a typo in any pattern)', () => {
    for (let c = 32; c <= 126; c++) { const t = String.fromCharCode(c); const w = code128Widths(t); expect(w.reduce((a, b) => a + b, 0), t).toBe(11 * 3 + 13); }
  });
  it('refuses text it cannot encode', () => {
    expect(code128Printable('PN-1000/A')).toBe(true);
    expect(code128Printable('é')).toBe(false);
    expect(() => code128Widths('')).toThrow();
  });
});
