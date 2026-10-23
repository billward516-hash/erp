import type { Tx } from '../../platform/db/tx.js';
import { many } from '../../platform/db/tx.js';
import { invalid } from '../../platform/errors.js';

/**
 * Units of measure (D-143). Standard units convert within their kind by fixed factors to a base unit; anything else
 * converts through the part's own units (how many stock units one of them holds). Codes are upper-case; common
 * spellings are normalized ("each", "pcs" → EA; "gallon" → GAL).
 */
type Kind = 'count' | 'length' | 'mass' | 'volume' | 'area' | 'time';
export const STANDARD: Record<string, { kind: Kind; base: number; label: string }> = {
  EA: { kind: 'count', base: 1, label: 'each' }, PR: { kind: 'count', base: 2, label: 'pair' }, DZ: { kind: 'count', base: 12, label: 'dozen' }, C: { kind: 'count', base: 100, label: 'hundred' },
  M: { kind: 'length', base: 1, label: 'metre' }, CM: { kind: 'length', base: 0.01, label: 'centimetre' }, MM: { kind: 'length', base: 0.001, label: 'millimetre' },
  IN: { kind: 'length', base: 0.0254, label: 'inch' }, FT: { kind: 'length', base: 0.3048, label: 'foot' }, YD: { kind: 'length', base: 0.9144, label: 'yard' },
  KG: { kind: 'mass', base: 1, label: 'kilogram' }, G: { kind: 'mass', base: 0.001, label: 'gram' }, LB: { kind: 'mass', base: 0.45359237, label: 'pound' }, OZ: { kind: 'mass', base: 0.028349523125, label: 'ounce' },
  L: { kind: 'volume', base: 1, label: 'litre' }, ML: { kind: 'volume', base: 0.001, label: 'millilitre' }, GAL: { kind: 'volume', base: 3.785411784, label: 'US gallon' },
  QT: { kind: 'volume', base: 0.946352946, label: 'US quart' }, PT: { kind: 'volume', base: 0.473176473, label: 'US pint' }, FLOZ: { kind: 'volume', base: 0.0295735295625, label: 'US fluid ounce' },
  M2: { kind: 'area', base: 1, label: 'square metre' }, FT2: { kind: 'area', base: 0.09290304, label: 'square foot' },
  H: { kind: 'time', base: 1, label: 'hour' }, MIN: { kind: 'time', base: 1 / 60, label: 'minute' },
};
const SPELLINGS: Record<string, string> = {
  EACH: 'EA', PC: 'EA', PCS: 'EA', PIECE: 'EA', PIECES: 'EA', UNIT: 'EA', UNITS: 'EA', E: 'EA', PAIR: 'PR', DOZ: 'DZ', DOZEN: 'DZ',
  METER: 'M', METRE: 'M', METERS: 'M', FOOT: 'FT', FEET: 'FT', INCH: 'IN', INCHES: 'IN', YARD: 'YD',
  KILOGRAM: 'KG', KGS: 'KG', GRAM: 'G', POUND: 'LB', LBS: 'LB', OUNCE: 'OZ', LITER: 'L', LITRE: 'L', LTR: 'L', GALLON: 'GAL', GALLONS: 'GAL', QUART: 'QT', PINT: 'PT',
  HR: 'H', HRS: 'H', HOUR: 'H', HOURS: 'H', BOX: 'BX', BOXES: 'BX', CASE: 'CS', CASES: 'CS', ROLL: 'RL', ROLLS: 'RL', PACK: 'PK', PKG: 'PK', DRUM: 'DR', PAIL: 'PL',
};
export function normalizeUom(u: string | null | undefined): string {
  const s = String(u ?? '').trim().toUpperCase().replace(/[.\s]/g, '');
  if (!s) return 'EA';
  return SPELLINGS[s] ?? s;
}

/** Stock units in one `from` for a part stocked in `stock`, or null when there is no conversion. */
export function factorBetween(from: string, stock: string, partUnits: Map<string, number>): number | null {
  const f = normalizeUom(from); const s = normalizeUom(stock);
  if (f === s) return 1;
  if (partUnits.has(f)) return partUnits.get(f)!;
  const a = STANDARD[f]; const b = STANDARD[s];
  if (a && b && a.kind === b.kind) return a.base / b.base;
  // A standard unit of the same kind as one of the part's own units (e.g. stocked in EA, a CS of 12, ordered by DZ).
  for (const [u, per] of partUnits) {
    const x = STANDARD[u];
    if (a && x && a.kind === x.kind) return (a.base / x.base) * per;
  }
  return null;
}

export async function partUnits(tx: Tx, partIds: string[]) {
  const rows = await many(tx, 'SELECT part_id, uom, per_unit::float AS per_unit FROM part_uom WHERE part_id = ANY ($1)', [partIds]);
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) { if (!out.has(r.part_id)) out.set(r.part_id, new Map()); out.get(r.part_id)!.set(r.uom, r.per_unit); }
  return out;
}

/** Like factorBetween, with a clear error naming the part when no conversion exists. */
export function requireFactor(from: string, part: { part_number: string; uom: string }, units: Map<string, number> | undefined) {
  const f = factorBetween(from, part.uom, units ?? new Map());
  if (f == null) throw invalid(`${part.part_number} is stocked in ${part.uom}; it has no conversion from ${normalizeUom(from)}. Add one under the part's units (how many ${part.uom} in one ${normalizeUom(from)})`);
  return f;
}
