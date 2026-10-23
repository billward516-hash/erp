/**
 * Code 128 (subset B, printable ASCII) as bar and space widths, for labels. Subset B is read by every scanner and covers part
 * numbers, location codes and lot numbers; nothing here depends on a font or an image library.
 */
const PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232').split(' ');
const STOP = '2331112';
export const START_B = 104;

export const code128Printable = (s: string) => s.length > 0 && s.length <= 48 && [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126);

/** Module widths (alternating bar, space, bar...) for the whole symbol including start, check character and stop. */
export function code128Widths(text: string): number[] {
  if (!code128Printable(text)) throw new Error('code 128 labels take 1 to 48 printable ASCII characters');
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  const check = (START_B + values.reduce((sum, v, i) => sum + v * (i + 1), 0)) % 103;
  return [START_B, ...values, check].map((v) => PATTERNS[v]!).concat(STOP).join('').split('').map(Number);
}

/** Draws the bars with any pdfkit-like document; returns the width used. */
export function drawCode128(doc: { rect: (x: number, y: number, w: number, h: number) => any; fill: (c?: string) => any }, text: string, x: number, y: number, height: number, module = 1.1) {
  let cx = x; let bar = true;
  for (const w of code128Widths(text)) {
    if (bar) doc.rect(cx, y, w * module, height).fill('#000000');
    cx += w * module; bar = !bar;
  }
  return cx - x;
}
