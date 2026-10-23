import v8 from 'node:v8';

/**
 * Regular expressions written by users (import mapping transforms, D-152). A pattern like `(a+)+$` can backtrack for
 * minutes on a short value and stall the server. V8 can switch any regex that backtracks excessively to its
 * linear-time engine; turned on here for the whole process. The linear engine does not support backreferences or
 * lookaround, so user patterns may not use them (mapping transforms have not needed them). If the fallback is not
 * active (a runtime without the flag), patterns that repeat a quantified group are refused instead.
 */
v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');
v8.setFlagsFromString('--regexp-backtracks-before-fallback=10000');

/** Measured once: does a catastrophic pattern finish quickly? */
export const linearFallback = (() => {
  const t = Date.now();
  new RegExp('^(a+)+$').test(`${'a'.repeat(30)}b`);
  return Date.now() - t < 200;
})();

const UNSUPPORTED = /\\[1-9]|\\k<|\(\?<?[=!]/;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

export function userRegex(pattern: string, flags = ''): RegExp {
  if (pattern.length > 200) throw new Error('regex pattern too long (200 characters at most)');
  if (UNSUPPORTED.test(pattern)) throw new Error('regex patterns may not use backreferences or lookaround');
  if (!linearFallback && NESTED_QUANTIFIER.test(pattern)) throw new Error('regex patterns may not repeat a group that already repeats, such as (a+)+');
  if (!/^[gimsu]*$/.test(flags)) throw new Error(`unsupported regex flags "${flags}"`);
  return new RegExp(pattern, flags);
}
