import { factorBetween, normalizeUom, STANDARD } from '../inventory/uom.js';

/**
 * Pure rules for chemicals (SC-007 C), kept apart from the database so they can be tested on their own.
 */
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Beyond-use date of an opened container: the opened date plus the part's in-use days, never later than the lot's expiry.
 * Without in-use days the container is only limited by its expiry; with neither there is no date.
 */
export function beyondUse(openedOn: string, inUseDays: number | null | undefined, expiresOn: string | null | undefined): string | null {
  const exp = expiresOn ? expiresOn.slice(0, 10) : null;
  if (!inUseDays) return exp;
  const by = addDays(openedOn, inUseDays);
  return exp && exp < by ? exp : by;
}

/** The earliest of several optional dates (null when none is given). */
export function earliest(...dates: (string | null | undefined)[]): string | null {
  const ds = dates.filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort();
  return ds[0] ?? null;
}

/**
 * Expiry of a prepared solution: the earliest of its components' use-by dates and the stated shelf life counted from the
 * preparation date. Neither given means no expiry is known.
 */
export function preparationExpiry(preparedOn: string, shelfLifeDays: number | null | undefined, componentUseBy: (string | null | undefined)[]): string | null {
  return earliest(shelfLifeDays ? addDays(preparedOn, shelfLifeDays) : null, ...componentUseBy);
}

/** CAS registry numbers: two to seven digits, two digits, then a check digit (the weighted digit sum modulo ten). */
export function casValid(cas: string): boolean {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas.trim());
  if (!m) return false;
  const digits = (m[1]! + m[2]!).split('').reverse();
  const sum = digits.reduce((s, d, i) => s + Number(d) * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}

/** Whether a date is more than N years before today (a revision exactly N years old is not yet older). */
export function olderThanYears(date: string, years: number, today = todayIso()): boolean {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10) < today;
}

/** Converts a quantity between two units of the same kind (litres to millilitres, pounds to kilograms); null when they do not convert. */
export function convertQty(qty: number, from: string, to: string): number | null {
  const f = factorBetween(from, to, new Map());
  return f == null ? null : qty * f;
}

/** The unit report quantities are added up in for a unit's kind (volume in litres, mass in kilograms), or the unit itself. */
export function baseUnit(uom: string): string {
  const k = STANDARD[normalizeUom(uom)]?.kind;
  return k === 'volume' ? 'L' : k === 'mass' ? 'KG' : normalizeUom(uom);
}

export const STARTER_HAZARD_CLASSES = [
  { code: 'flammable', label: 'Flammable', pictogram: 'GHS02' },
  { code: 'oxidizer', label: 'Oxidizer', pictogram: 'GHS03' },
  { code: 'corrosive', label: 'Corrosive', pictogram: 'GHS05' },
  { code: 'toxic', label: 'Toxic', pictogram: 'GHS06' },
  { code: 'compressed_gas', label: 'Compressed gas', pictogram: 'GHS04' },
  { code: 'health_hazard', label: 'Health hazard', pictogram: 'GHS08' },
  { code: 'environmental', label: 'Environmental hazard', pictogram: 'GHS09' },
  { code: 'explosive', label: 'Explosive', pictogram: 'GHS01' },
] as const;

/** An editable starting point, NOT certified: the company confirms it against its safety data sheets and its own safety lead. */
export const STARTER_STORAGE_GROUPS = [
  { code: 'ACID', name: 'Acids', description: 'Mineral and organic acids' },
  { code: 'BASE', name: 'Bases', description: 'Caustics and alkalis' },
  { code: 'OXID', name: 'Oxidizers', description: 'Oxidizing agents' },
  { code: 'FLAM', name: 'Flammables', description: 'Flammable liquids and solids' },
  { code: 'TOXIC', name: 'Toxics', description: 'Toxic materials' },
  { code: 'GAS', name: 'Compressed gases', description: 'Cylinders and gas lecture bottles' },
  { code: 'GEN', name: 'General', description: 'No special segregation set by the company' },
] as const;
export const STARTER_INCOMPATIBLE: [string, string, string][] = [
  ['ACID', 'BASE', 'Acids and bases react together'],
  ['OXID', 'FLAM', 'Oxidizers can ignite or feed a fire with flammable materials'],
];
export const STARTER_NOTE = 'Starter list for the company to review and edit. It is NOT certified: check it against each safety data sheet (section 7) and your own safety lead.';
