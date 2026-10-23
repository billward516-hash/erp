import { describe, expect, it } from 'vitest';
import { applyTransforms, TransformSchema } from '../src/modules/imports/mapping/spec.js';
import { linearFallback, userRegex } from '../src/platform/safe-regex.js';

/** User-written regex in mapping transforms (D-152). */
describe('user regex patterns', () => {
  it('a pattern that backtracks catastrophically finishes in milliseconds instead of stalling the server', () => {
    expect(linearFallback).toBe(true);
    const t = Date.now();
    const out = applyTransforms(`${'a'.repeat(5000)}!`, [TransformSchema.parse({ op: 'regex_extract', pattern: '^((a+)+)$' })]);
    expect(out).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('ordinary patterns behave as before', () => {
    expect(applyTransforms('PN-00123 (rev B)', [TransformSchema.parse({ op: 'regex_extract', pattern: 'PN-(\\d+)' })])).toBe('00123');
    expect(applyTransforms('1,234.50 USD', [TransformSchema.parse({ op: 'replace', pattern: '[^0-9.]', with: '' })])).toBe('1234.50');
  });

  it('refuses constructs the linear engine cannot run, when the profile is saved', () => {
    for (const pattern of ['(a)\\1', '(?<x>a)\\k<x>', 'a(?=b)', '(?<!x)y', 'x'.repeat(201)]) {
      expect(TransformSchema.safeParse({ op: 'regex_extract', pattern }).success, pattern).toBe(false);
    }
    expect(TransformSchema.safeParse({ op: 'replace', pattern: '(' }).success).toBe(false);
    expect(() => userRegex('a', 'y')).toThrow(/unsupported regex flags/);
  });
});
