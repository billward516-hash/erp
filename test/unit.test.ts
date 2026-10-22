import { describe, expect, it } from 'vitest';
import { computeUtilization } from '../src/modules/assets/utilization.js';
import { inferDateFormat, parseBoolean, parseDate, parseDateTime, parseNumber } from '../src/modules/imports/mapping/coerce.js';
import { applyTransforms, readSource } from '../src/modules/imports/mapping/spec.js';
import { normalizeHeader, suggestMapping } from '../src/modules/imports/mapping/suggest.js';
import { detectHeaderRow, parseFile, sniffDelimiter } from '../src/modules/imports/parsers/index.js';
import { splitFullName } from '../src/modules/imports/targets/employees.js';
import { getTarget } from '../src/modules/imports/targets/registry.js';
import { csvCell } from '../src/modules/reporting/render/csv.js';

const h = (iso: string) => new Date(iso);

describe('utilization calculation', () => {
  const start = h('2026-01-01T00:00:00Z');
  const end = h('2026-01-02T00:00:00Z'); // 24 h

  it('splits time by state and computes availability against scheduled time', () => {
    const r = computeUtilization([
      { state: 'running', startedAt: h('2026-01-01T00:00:00Z'), endedAt: h('2026-01-01T12:00:00Z') },
      { state: 'unplanned_downtime', startedAt: h('2026-01-01T12:00:00Z'), endedAt: h('2026-01-01T15:00:00Z') },
      { state: 'planned_downtime', startedAt: h('2026-01-01T15:00:00Z'), endedAt: h('2026-01-01T19:00:00Z') },
      { state: 'idle', startedAt: h('2026-01-01T19:00:00Z'), endedAt: h('2026-01-02T00:00:00Z') },
    ], start, end, { now: h('2026-02-01T00:00:00Z') });
    expect(r.hoursByState).toMatchObject({ running: 12, unplanned_downtime: 3, planned_downtime: 4, idle: 5 });
    expect(r.scheduledHours).toBe(20);
    expect(r.availability).toBe(0.85); // (20 - 3) / 20
    expect(r.utilization).toBe(0.6); // 12 / 20
    expect(r.coverage).toBe(1);
    expect(r.unplannedStops).toBe(1);
  });

  it('calendar basis divides by the whole window', () => {
    const r = computeUtilization([{ state: 'running', startedAt: start, endedAt: h('2026-01-01T06:00:00Z') }], start, end, { basis: 'calendar', now: end });
    expect(r.utilization).toBe(0.25);
  });

  it('clips intervals to the window and runs open intervals only until now', () => {
    const r = computeUtilization([{ state: 'running', startedAt: h('2025-12-31T20:00:00Z'), endedAt: null }], start, end, { now: h('2026-01-01T10:00:00Z') });
    expect(r.hoursByState.running).toBe(10);
    expect(r.unrecordedHours).toBe(14);
  });

  it('reports missing data as null, never as zero', () => {
    const r = computeUtilization([], start, end, { now: end });
    expect(r.availability).toBeNull();
    expect(r.utilization).toBeNull();
    expect(r.coverage).toBe(0);
    expect(r.unrecordedHours).toBe(24);
  });
});

describe('value coercion', () => {
  it.each([
    ['$1,234.50', 1234.5], ['1.234,50', 1234.5], ['(12.00)', -12], ['12,5', 12.5], ['1,000', 1000], [' 7 ', 7], ['45%', 45], ['USD 99', 99], ['15-', -15],
  ])('number %s', (input, expected) => expect(parseNumber(input)).toEqual({ ok: true, value: expected }));

  it('rejects non-numbers with a reason', () => {
    expect(parseNumber('call for price')).toMatchObject({ ok: false });
    expect(parseNumber('N/A')).toEqual({ ok: true, value: null });
  });

  it.each([
    ['2026-03-04', '2026-03-04'], ['3/4/2026', '2026-03-04'], ['03/04/26', '2026-03-04'], ['4-Mar-2026', '2026-03-04'],
    ['Mar 4, 2026', '2026-03-04'], ['20260304', '2026-03-04'], [46085, '2026-03-04'], ['2026-03-04T10:00:00Z', '2026-03-04'],
  ])('date %s', (input, expected) => expect(parseDate(input as any)).toEqual({ ok: true, value: expected }));

  it('rejects impossible dates', () => {
    expect(parseDate('02/30/2026').ok).toBe(false);
    expect(parseDate('13/13/2026').ok).toBe(false);
  });

  it('infers day-first columns from an unambiguous value and flags fully ambiguous columns', () => {
    const dmy = inferDateFormat(['03/04/2026', '25/04/2026']);
    expect(dmy.formats[0]).toBe('DD/MM/YYYY');
    expect(dmy.ambiguous).toBeNull();
    const amb = inferDateFormat(['03/04/2026', '05/06/2026']);
    expect(amb.formats[0]).toBe('MM/DD/YYYY');
    expect(amb.ambiguous?.alternatives).toContain('DD/MM/YYYY');
    expect(inferDateFormat(['03/04/2026'], 'DMY').formats[0]).toBe('DD/MM/YYYY');
  });

  it('interprets zone-less timestamps in the facility time zone (DST-aware)', () => {
    expect(parseDateTime('03/02/2026 09:20', { timeZone: 'America/New_York' })).toEqual({ ok: true, value: '2026-03-02T14:20:00.000Z' });
    expect(parseDateTime('2026-03-09 10:00', { timeZone: 'America/New_York' })).toEqual({ ok: true, value: '2026-03-09T14:00:00.000Z' });
    expect(parseDateTime('3/9/2026 1:30 PM', { timeZone: 'America/Chicago' })).toEqual({ ok: true, value: '2026-03-09T18:30:00.000Z' });
    expect(parseDateTime('2026-03-09T10:00:00+02:00', { timeZone: 'America/New_York' })).toEqual({ ok: true, value: '2026-03-09T08:00:00.000Z' });
  });

  it('booleans accept common spellings and field-specific synonyms', () => {
    expect(parseBoolean('Y')).toEqual({ ok: true, value: true });
    expect(parseBoolean('x')).toEqual({ ok: true, value: true });
    expect(parseBoolean('Obsolete', { false: ['obsolete'] })).toEqual({ ok: true, value: false });
    expect(parseBoolean('maybe').ok).toBe(false);
  });
});

describe('mapping transforms', () => {
  it('templates combine columns and drop dangling separators', () => {
    expect(readSource({ Bldg: 'Bldg 2', Line: 'Line 3' }, { template: '{Bldg} > {Line}', transforms: [] })).toBe('Bldg 2 > Line 3');
    expect(readSource({ Bldg: 'Bldg 2', Line: '' }, { template: '{Bldg} > {Line}', transforms: [] })).toBe('Bldg 2');
    expect(readSource({ Bldg: '', Line: '' }, { template: '{Bldg} > {Line}', transforms: [] })).toBeNull();
  });
  it('first non-blank of several source columns wins', () => {
    expect(readSource({ A: '', B: 'b' }, { source: ['A', 'B'], transforms: [] })).toBe('b');
  });
  it('applies declarative steps in order', () => {
    expect(applyTransforms(' cnc-101 ', [{ op: 'trim' }, { op: 'upper' }])).toBe('CNC-101');
    expect(applyTransforms('190', [{ op: 'multiply', factor: 1 / 60 }])).toBeCloseTo(3.1667, 3);
    expect(applyTransforms('Asset: HMC-201 (old)', [{ op: 'regex_extract', pattern: '([A-Z]+-\\d+)', group: 1 }])).toBe('HMC-201');
    expect(applyTransforms('', [{ op: 'default', value: 'EA' }])).toBe('EA');
    expect(applyTransforms('Smith, Jo', [{ op: 'split', separator: ',', index: 0 }])).toBe('Smith');
  });
  it('splits names in either order', () => {
    expect(splitFullName('Shah, Priya')).toEqual({ first: 'Priya', last: 'Shah' });
    expect(splitFullName('Priya K. Shah')).toEqual({ first: 'Priya', last: 'Shah' });
    expect(splitFullName('Cher')).toBeNull();
  });
});

describe('auto-mapping', () => {
  it('normalizes real-world headers', () => {
    expect(normalizeHeader('Equip #')).toBe('equipment number');
    expect(normalizeHeader('S/N')).toBe('serial number');
    expect(normalizeHeader('InstallDate')).toBe('install date');
    expect(normalizeHeader('Mfr P/N')).toBe('manufacturer part number');
  });

  it('maps an unfamiliar CMMS-style asset export with confidence levels', () => {
    const cols = ['Equipment ID', 'Equip Desc', 'Manufacturer', 'Model No', 'Serial', 'Location', 'Criticality', 'In-Service Date', 'Coolant'];
    const s = suggestMapping(getTarget('assets')!, cols, [{ 'Equipment ID': 'P-1', 'Equip Desc': 'Pump', Criticality: 'A', 'In-Service Date': '2020-01-01' }]);
    const m = Object.fromEntries(s.suggestions.map((x) => [x.column, x.field]));
    expect(m).toMatchObject({ 'Equipment ID': 'asset_tag', 'Equip Desc': 'name', Manufacturer: 'manufacturer', 'Model No': 'model',
      Serial: 'serial_number', Location: 'location_path', Criticality: 'criticality', 'In-Service Date': 'commissioned_on' });
    expect(s.unmappedColumns).toEqual(['Coolant']);
    expect(s.missingRequired).toEqual([]);
  });

  it('demotes a header match when the values do not fit the field type', () => {
    const s = suggestMapping(getTarget('parts')!, ['Part', 'Cost'], [{ Part: 'X-1', Cost: 'see quote' }, { Part: 'X-2', Cost: 'TBD later' }]);
    expect(s.suggestions.find((x) => x.column === 'Cost')).toMatchObject({ field: 'unit_cost', level: 'low', note: expect.stringContaining('not valid number') });
  });

  it('lists enum values that need a decision', () => {
    const s = suggestMapping(getTarget('assets')!, ['Tag', 'Name', 'Criticality'], [{ Tag: 'A', Name: 'n', Criticality: 'Vital' }, { Tag: 'B', Name: 'n', Criticality: 'Meh' }]);
    expect(s.unmatchedValues.criticality).toEqual(['Meh']);
  });
});

describe('file parsing', () => {
  it('sniffs delimiters', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
    expect(sniffDelimiter('a,"b;x",c\n1,2,3\n')).toBe(',');
  });

  it('skips report banners above the header row', () => {
    expect(detectHeaderRow([['Equipment List — exported 2026'], [], ['Tag', 'Name', 'Make'], ['A', 'B', 'C']])).toBe(2);
  });

  it('decodes Windows-1252, de-duplicates headers and keeps row numbers', async () => {
    const buf = Buffer.from([...Buffer.from('Part;Desc;Desc\r\nP1;90'), 0xb0, ...Buffer.from(' elbow;x\r\n\r\nP2;b;y\r\n')]);
    const t = await parseFile(buf, 'parts.csv');
    expect(t.columns).toEqual(['Part', 'Desc', 'Desc (2)']);
    expect(t.rows.map((r) => [r.rowNumber, r.values.Desc])).toEqual([[2, '90° elbow'], [4, 'b']]);
    expect(t.info).toMatchObject({ encoding: 'windows-1252', delimiter: ';', skippedBlankRows: 1 });
  });

  it('flattens nested JSON records', async () => {
    const t = await parseFile(Buffer.from(JSON.stringify({ items: [{ id: 1, asset: { tag: 'A' }, tags: ['x', 'y'] }] })), 'x.json');
    expect(t.columns).toEqual(['id', 'asset.tag', 'tags']);
    expect(t.rows[0]!.values).toEqual({ id: 1, 'asset.tag': 'A', tags: 'x; y' });
  });
});

describe('export safety', () => {
  it('neutralizes spreadsheet formulas and quotes properly', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});

describe('report wording', () => {
  it('pluralizes nouns used in report sentences', async () => {
    const { plural } = await import('../src/modules/reporting/definitions.js');
    expect([plural(1, 'open opportunity'), plural(4, 'open opportunity'), plural(3, 'day'), plural(2, 'person'), plural(0, 'quote'), plural(5, 'PM'), plural(2, 'near miss'), plural(3, 'box')])
      .toEqual(['1 open opportunity', '4 open opportunities', '3 days', '2 people', '0 quotes', '5 PMs', '2 near misses', '3 boxes']);
  });
});
