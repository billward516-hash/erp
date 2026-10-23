/**
 * Demand, capacity and material plan (docs/ARCHITECTURE.md §12m). A pure, deterministic function of its inputs:
 * the service gathers them, this computes, the report and the page render. Every assumption the calculation had to
 * make (no calendar, no performance history, no routing) is listed in `assumptions` rather than hidden.
 *
 *  1. Demand per finished part and month: per customer, firm orders consume that customer's forecast for the month
 *     (demand = max(forecast × (1 + scenario %), firm)); firm orders past due fall into the first month.
 *  2. Net requirements, month by month, lot for lot: on hand plus open production due, minus demand; a shortfall is
 *     planned production in that month. Open production orders' unissued materials are demand on their components. Made components are netted the same way, level by level (low-level codes).
 *  3. Load: open production (committed) and planned production through the released routing. Run time per good unit
 *     is demonstrated (≥ MIN_OBSERVED good units in the history) or standard ÷ demonstrated (or assumed) yield;
 *     one setup per part, operation and month.
 *  4. Capacity per work center and month: hours per week × machines or crews × weeks in the month × demonstrated
 *     availability of its machines, less preventive maintenance projected on those machines; scenarios add hours or units.
 *  5. Materials: purchased components' requirements against available stock and open purchase orders by expected
 *     month; the first month short gives the need-by date and, with the lead time, the order-by date. Quantities
 *     already on open purchase requests (not yet ordered) reduce what is left to request, not the projected balance.
 */

export const MIN_OBSERVED = 20;
export const DEFAULT_HOURS_PER_WEEK = 40;

export interface Operation { opNo: number; workCenterId: string; setupMinutes: number; runMinutesPerUnit: number }
export interface Material { partId: string; qtyPer: number; scrapPct: number }
export interface Item {
  partId: string; partNumber: string; description: string;
  /** A released revision exists: the part is made here (else bought). */
  made: boolean; operations: Operation[]; materials: Material[];
  available: number; leadTimeDays: number | null;
  /** Open production orders for the part: remaining quantity by due month. */
  openProduction: { month: string; qty: number }[];
  /** Open purchase order lines: remaining quantity by expected month (null = no date). */
  openPurchases: { month: string | null; qty: number }[];
  /** On open purchase requests not yet ordered (no expected date until a buyer orders it). */
  requested?: number;
  /** Standard unit cost, for the consumables cost forecast. */
  unitCost?: number | null;
}
/** A consumable or chemical used at a work center: per machine hour, per unit made there, or a fixed quantity a month. */
export interface ConsumptionRule { id: string; partId: string; workCenterId: string | null; basis: 'machine_hour' | 'unit' | 'month'; rate: number; note?: string | null }
export interface Performance { partId: string; opNo: number; goodUnits: number; scrapUnits: number; runMinutes: number }
export interface WorkCenter { id: string; code: string; name: string; hoursPerWeek: number | null; units: number | null; machines: number; availability: number | null;
  /** Preventive maintenance projected on the work center's machines, hours per month of the horizon. */
  maintenanceHours?: number[];
  /** Qualifications needed to operate its machines (all of them); empty = no qualified-labor constraint. */
  requiredQualifications?: string[];
  /** Operator hours per machine hour (0.5 = one operator tends two machines). Default 1. */
  laborRatio?: number | null }
export interface Person {
  id: string; name: string;
  /** Demonstrated worked hours a week (approved timesheets), or null when there is too little history. */
  hoursPerWeek: number | null;
  qualifications: { id: string; code: string; effectiveOn: string; expiresOn: string | null }[];
}
export interface DemandRow { partId: string; customerId: string; customer: string; month: string; forecast: number; firm: number }
export interface Scenario { demandPct: number; adjustments: { workCenterId: string; extraHoursPerWeek?: number; extraUnits?: number }[] }
export interface PlanInput {
  months: string[];          // YYYY-MM, first is the current month
  today: string;             // YYYY-MM-DD
  demand: DemandRow[];
  items: Item[];
  workCenters: WorkCenter[];
  performance: Performance[];
  scenario?: Scenario;
  /** Materials still to issue to open production orders, by the order's due month (dependent demand already committed). */
  allocations?: { partId: string; month: string; qty: number }[];
  /** Consumption rates for production consumables and chemicals at the site. */
  consumption?: ConsumptionRule[];
  /** Parts on preventive maintenance plans, already projected per month of the horizon (quantity per occurrence × occurrences). */
  maintenanceParts?: { partId: string; planCode: string; qty: number[] }[];
  /** People at the site who could operate machines (active employees with their current qualifications). */
  people?: Person[];
  /** Codes of the qualifications named by work centers, for display. */
  qualificationCodes?: Record<string, string>;
  /** Assumptions made while gathering the inputs (listed with the engine's own). */
  notes?: string[];
}

/** arr[k] += v, for arrays sized to the horizon (strict index checks). */
const inc = (arr: number[], k: number, v: number) => { arr[k] = (arr[k] ?? 0) + v; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const daysIn = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Preventive-maintenance hours per month from calendar plans: each occurrence from the next due date, stepping by the
 * interval. An overdue occurrence counts once in the current month and the cycle restarts from today (as if done now).
 */
export function projectMaintenance(plans: { nextDueOn: string; intervalDays: number; hours: number }[], months: string[], today: string) {
  const out = months.map(() => 0);
  const end = addDays(`${months[months.length - 1]}-01`, daysIn(months[months.length - 1]!) - 1);
  for (const p of plans) {
    if (!(p.intervalDays > 0) || !(p.hours > 0)) continue;
    let d = p.nextDueOn;
    if (d < today) { inc(out, 0, p.hours); d = addDays(today, p.intervalDays); }
    for (; d <= end; d = addDays(d, p.intervalDays)) {
      const k = months.indexOf(d.slice(0, 7));
      if (k >= 0) inc(out, k, p.hours);
    }
  }
  return out.map(r1);
}

export function computePlan(input: PlanInput) {
  const { months } = input;
  const idx = new Map(months.map((m, i) => [m, i]));
  const at = (m: string | null) => (m == null || m < months[0]! ? 0 : idx.get(m) ?? -1);   // past → first month; beyond horizon → -1
  const items = new Map(input.items.map((i) => [i.partId, i]));
  const pct = (input.scenario?.demandPct ?? 0) / 100;
  const assumptions = new Set<string>(input.notes ?? []);

  // 1. Demand (independent): firm consumes forecast per customer and month.
  const independent = new Map<string, number[]>();
  const firmShare = new Map<string, { firm: number[]; forecast: number[] }>();
  const independentFirm = new Map<string, number[]>();
  for (const d of input.demand) {
    const k = at(d.month);
    if (k < 0) continue;
    const fc = d.forecast * (1 + pct);
    const total = Math.max(fc, d.firm);
    const v = independent.get(d.partId) ?? months.map(() => 0); inc(v, k, total); independent.set(d.partId, v);
    const s = firmShare.get(d.partId) ?? { firm: months.map(() => 0), forecast: months.map(() => 0) };
    inc(s.firm, k, d.firm); inc(s.forecast, k, total - d.firm); firmShare.set(d.partId, s);
    const f = independentFirm.get(d.partId) ?? months.map(() => 0); inc(f, k, d.firm); independentFirm.set(d.partId, f);
  }

  // Low-level codes: a part's level is the deepest it appears in any BOM, so it is netted after all its parents.
  const level = new Map<string, number>();
  const visit = (id: string, l: number, path: Set<string>) => {
    if (path.has(id)) return; // circular BOMs are refused at release (S8a); guard anyway
    if ((level.get(id) ?? -1) >= l) return;
    level.set(id, l);
    const it = items.get(id);
    if (it?.made) for (const m of it.materials) visit(m.partId, l + 1, new Set([...path, id]));
  };
  for (const id of independent.keys()) visit(id, 0, new Set());
  for (const a of input.allocations ?? []) visit(a.partId, 1, new Set());
  const order = [...level.keys()].sort((a, b) => level.get(a)! - level.get(b)!);

  // 2. Netting, level by level; dependent demand from planned production of parents in the same month.
  const gross = new Map<string, number[]>([...independent].map(([k, v]) => [k, [...v]]));
  // Open production orders' remaining materials: committed, so labelled firm.
  for (const a of input.allocations ?? []) {
    const k = at(a.month);
    if (k < 0 || !(a.qty > 0)) continue;
    const g = gross.get(a.partId) ?? months.map(() => 0); inc(g, k, a.qty); gross.set(a.partId, g);
    const s = firmShare.get(a.partId) ?? { firm: months.map(() => 0), forecast: months.map(() => 0) }; inc(s.firm, k, a.qty); firmShare.set(a.partId, s);
  }
  const planned = new Map<string, number[]>();
  const purchased: string[] = [];
  for (const id of order) {
    const it = items.get(id);
    const g = gross.get(id) ?? months.map(() => 0);
    if (!it) { assumptions.add(`A part in demand or a BOM is not in the part master; left out`); continue; }
    if (!it.made) { purchased.push(id); continue; } // netted after the load is known (consumables follow machine hours)
    const supply = months.map(() => 0);
    for (const p of it.openProduction) { const k = at(p.month); if (k >= 0) inc(supply, k, p.qty); }
    let bal = it.available;
    const plan = months.map((_, k) => { bal += supply[k]! - g[k]!; if (bal < 0) { const q = -bal; bal = 0; return q; } return 0; });
    planned.set(id, plan);
    // Components inherit the parent's firm/forecast split, so their load is labelled the same way.
    const ps = firmShare.get(id);
    for (const m of it.materials) {
      const factor = m.qtyPer * (1 + m.scrapPct / 100); // the same allowance production release uses (D-161)
      const cg = gross.get(m.partId) ?? months.map(() => 0);
      const cs = firmShare.get(m.partId) ?? { firm: months.map(() => 0), forecast: months.map(() => 0) };
      plan.forEach((q, k) => {
        inc(cg, k, q * factor);
        const tot = ps ? ps.firm[k]! + ps.forecast[k]! : 0;
        const f = tot > 0 ? ps!.firm[k]! / tot : 0;
        inc(cs.firm, k, q * factor * f); inc(cs.forecast, k, q * factor * (1 - f));
      });
      gross.set(m.partId, cg);
      firmShare.set(m.partId, cs);
    }
  }

  // 3. Load per work center and month.
  const perf = new Map<string, Performance>(input.performance.map((p) => [`${p.partId}|${p.opNo}`, p]));
  const opRate = (it: Item, op: Operation) => {
    const p = perf.get(`${it.partId}|${op.opNo}`);
    if (p && p.goodUnits >= MIN_OBSERVED && p.runMinutes > 0) return { minPerGood: p.runMinutes / p.goodUnits, basis: 'demonstrated' as const, yield: p.goodUnits / (p.goodUnits + p.scrapUnits) };
    const y = p && p.goodUnits + p.scrapUnits >= MIN_OBSERVED ? p.goodUnits / (p.goodUnits + p.scrapUnits) : 1;
    if (!(p && p.goodUnits + p.scrapUnits >= MIN_OBSERVED)) assumptions.add(`Standard run times and 100% yield assumed where fewer than ${MIN_OBSERVED} units have been recorded (e.g. ${it.partNumber} op ${op.opNo})`);
    return { minPerGood: op.runMinutesPerUnit / (y || 1), basis: 'standard' as const, yield: y };
  };
  const wcs = new Map(input.workCenters.map((w) => [w.id, w]));
  const load = new Map<string, { committed: number[]; firm: number[]; forecast: number[]; units: number[]; parts: Map<string, number> }>();
  const addLoad = (it: Item, qtys: number[], kind: 'committed' | 'planned') => {
    if (!it.operations.length) { if (qtys.some((q) => q > 0)) assumptions.add(`${it.partNumber} has no routing; its production adds no load`); return; }
    for (const op of it.operations) {
      const L = load.get(op.workCenterId) ?? { committed: months.map(() => 0), firm: months.map(() => 0), forecast: months.map(() => 0), units: months.map(() => 0), parts: new Map() };
      const rate = opRate(it, op);
      qtys.forEach((q, k) => {
        if (q <= 0) return;
        const h = (op.setupMinutes + q * rate.minPerGood) / 60;
        inc(L.units, k, q);
        if (kind === 'committed') inc(L.committed, k, h);
        else {
          // Split planned load between firm and forecast in proportion to the part's demand that month.
          const s = firmShare.get(it.partId);
          const tot = s ? s.firm[k]! + s.forecast[k]! : 0;
          const f = tot > 0 ? Math.min(1, s!.firm[k]! / tot) : 0;
          inc(L.firm, k, h * f); inc(L.forecast, k, h * (1 - f));
        }
        L.parts.set(it.partNumber, (L.parts.get(it.partNumber) ?? 0) + h);
      });
      load.set(op.workCenterId, L);
    }
  };
  for (const it of input.items.filter((i) => i.made)) {
    const committed = months.map(() => 0);
    for (const p of it.openProduction) { const k = at(p.month); if (k >= 0) inc(committed, k, p.qty); }
    addLoad(it, committed, 'committed');
    if (planned.has(it.partId)) addLoad(it, planned.get(it.partId)!, 'planned');
  }

  // 4. Capacity.
  const adj = new Map((input.scenario?.adjustments ?? []).map((a) => [a.workCenterId, a]));
  const workCenters = input.workCenters.map((w) => {
    const a = adj.get(w.id);
    if (w.hoursPerWeek == null) assumptions.add(`${w.code} has no calendar; ${DEFAULT_HOURS_PER_WEEK} hours a week assumed`);
    // Manual work centers (no machines) have no machine availability to measure.
    if (w.availability == null && w.machines > 0) assumptions.add(`${w.code}: no machine state history; 100% availability assumed`);
    const hours = (w.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK) + (a?.extraHoursPerWeek ?? 0);
    const units = (w.units ?? Math.max(1, w.machines)) + (a?.extraUnits ?? 0);
    const avail = w.availability ?? 1;
    const L = load.get(w.id);
    const cells = months.map((m, k) => {
      const scheduled = hours * units * daysIn(m) / 7;
      const maintenance = w.maintenanceHours?.[k] ?? 0;
      const capacity = Math.max(0, scheduled * avail - maintenance);
      const committed = L?.committed[k] ?? 0; const firm = L?.firm[k] ?? 0; const forecast = L?.forecast[k] ?? 0;
      const required = committed + firm + forecast;
      return { month: m, scheduled: r1(scheduled), maintenance: r1(maintenance), capacity: r1(capacity), committed: r1(committed), firm: r1(firm), forecast: r1(forecast), required: r1(required),
        utilization: capacity > 0 ? r3(required / capacity) : null, shortfall: r1(Math.max(0, required - capacity)) };
    });
    const peak = cells.reduce((p, c) => ((c.utilization ?? 0) > (p.utilization ?? 0) ? c : p), cells[0]!);
    return { id: w.id, code: w.code, name: w.name, hoursPerWeek: hours, units, availability: w.availability, cells, peak,
      topParts: [...(L?.parts ?? new Map())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, h]) => ({ part: p, hours: r1(h) })) };
  });
  for (const id of load.keys()) if (!wcs.has(id)) assumptions.add('A routing uses a work center that is inactive or at another site; its load is not shown');
  const labor = planLabor(input, workCenters, assumptions);

  // 5. Consumables, chemicals and maintenance parts add to purchased requirements; then purchased materials are projected.
  const source = new Map<string, { production: number[]; consumables: number[]; maintenance: number[] }>();
  const src = (id: string) => { const x = source.get(id) ?? { production: [...(gross.get(id) ?? months.map(() => 0))], consumables: months.map(() => 0), maintenance: months.map(() => 0) }; source.set(id, x); return x; };
  for (const id of purchased) src(id);
  const addGross = (id: string, k: number, q: number) => { const g = gross.get(id) ?? months.map(() => 0); inc(g, k, q); gross.set(id, g); };
  const consumption = [];
  for (const c of input.consumption ?? []) {
    const it = items.get(c.partId);
    if (!it) { assumptions.add('A consumption rate names a part that is not in the part master; left out'); continue; }
    const L = c.workCenterId ? load.get(c.workCenterId) : undefined;
    const wcCode = c.workCenterId ? wcs.get(c.workCenterId)?.code ?? null : null;
    if (c.workCenterId && !wcs.has(c.workCenterId)) { assumptions.add('A consumption rate names a work center that is inactive or at another site; left out'); continue; }
    const qty = months.map((_, k) => c.basis === 'month' ? c.rate
      : c.basis === 'machine_hour' ? c.rate * ((L?.committed[k] ?? 0) + (L?.firm[k] ?? 0) + (L?.forecast[k] ?? 0)) : c.rate * (L?.units[k] ?? 0));
    const x = src(c.partId);
    qty.forEach((q, k) => { if (q > 0) { addGross(c.partId, k, q); inc(x.consumables, k, q); } });
    if (it.made) assumptions.add(`${it.partNumber} is consumed at a rate but is made here; consumption of parts made in house is not planned`);
    if (it.unitCost == null) assumptions.add(`No unit cost for ${it.partNumber}; its consumption is not in the cost forecast`);
    consumption.push({ id: c.id, partId: c.partId, partNumber: it.partNumber, description: it.description, workCenter: wcCode, basis: c.basis, rate: c.rate, note: c.note ?? null,
      qty: qty.map(r3), cost: it.unitCost == null ? null : qty.map((q) => Math.round(q * it.unitCost! * 100) / 100) });
  }
  const maintenanceParts = [];
  for (const m of input.maintenanceParts ?? []) {
    const it = items.get(m.partId);
    if (!it) continue;
    const x = src(m.partId);
    m.qty.forEach((q, k) => { if (q > 0) { addGross(m.partId, k, q); inc(x.maintenance, k, q); } });
    maintenanceParts.push({ partId: m.partId, partNumber: it.partNumber, description: it.description, plan: m.planCode, qty: m.qty.map(r3),
      cost: it.unitCost == null ? null : m.qty.map((q) => Math.round(q * it.unitCost! * 100) / 100) });
  }
  const materialRows = [];
  for (const id of source.keys()) {
    const it = items.get(id)!;
    if (it.made) continue;
    const g = gross.get(id) ?? months.map(() => 0);
    const by = source.get(id)!;
    const receipts = months.map(() => 0);
    for (const p of it.openPurchases) {
      const k = at(p.month);
      if (k >= 0) inc(receipts, k, p.qty);
      if (p.month == null) assumptions.add(`Open purchase orders without an expected date are counted as arriving this month (${it.partNumber})`);
    }
    let bal = it.available; let firstShort = -1; let short = 0;
    const projected = months.map((_, k) => { bal += receipts[k]! - g[k]!; if (bal < -1e-9 && firstShort < 0) firstShort = k; return r3(bal); });
    if (firstShort >= 0) short = -Math.min(...projected.slice(firstShort));
    if (g.some((x) => x > 0)) {
      // Needed from the start of the first short month, or today if that is the current month.
      const needBy = firstShort >= 0 ? (`${months[firstShort]}-01` < input.today ? input.today : `${months[firstShort]}-01`) : null;
      if (firstShort >= 0 && it.leadTimeDays == null) assumptions.add(`No supplier lead time for ${it.partNumber}; order-by date shown as the need-by date`);
      const orderBy = needBy ? addDays(needBy, -(it.leadTimeDays ?? 0)) : null;
      materialRows.push({ partId: id, partNumber: it.partNumber, description: it.description, required: g.map(r3),
        bySource: { production: r3(by.production.reduce((a, b) => a + b, 0)), consumables: r3(by.consumables.reduce((a, b) => a + b, 0)), maintenance: r3(by.maintenance.reduce((a, b) => a + b, 0)) }, receipts: receipts.map(r3), projected, available: r3(it.available),
        shortQty: r3(short), requested: r3(it.requested ?? 0), toRequest: r3(Math.max(0, short - (it.requested ?? 0))), needBy, orderBy, late: !!orderBy && orderBy < input.today, leadTimeDays: it.leadTimeDays });
    }
  }
  const sumCost = (rows: { cost: number[] | null }[]) => months.map((_, k) => Math.round(rows.reduce((t, r) => t + (r.cost?.[k] ?? 0), 0) * 100) / 100);
  const consumablesCost = { consumables: sumCost(consumption), maintenance: sumCost(maintenanceParts) };
  const bottleneck = workCenters.filter((w) => w.peak.utilization != null).sort((a, b) => b.peak.utilization! - a.peak.utilization!)[0] ?? null;

  const demand = months.map((m, k) => {
    let firm = 0; let total = 0;
    for (const [id, v] of independent) { total += v[k]!; firm += independentFirm.get(id)![k]!; }
    return { month: m, firm: r1(firm), forecast: r1(total - firm), total: r1(total) };
  });
  const production = [...planned].filter(([, v]) => v.some((q) => q > 0)).map(([id, v]) => ({ partId: id, partNumber: items.get(id)!.partNumber, description: items.get(id)!.description, qty: v.map(r3) }));
  return {
    months, demand, production, workCenters, bottleneck: bottleneck ? { code: bottleneck.code, name: bottleneck.name, month: bottleneck.peak.month, utilization: bottleneck.peak.utilization } : null,
    labor, consumption, maintenanceParts, consumablesCost,
    materials: materialRows.sort((a, b) => (a.needBy ?? '9999').localeCompare(b.needBy ?? '9999') || a.partNumber.localeCompare(b.partNumber)),
    assumptions: [...assumptions].sort(),
  };
}

export type Plan = ReturnType<typeof computePlan>;

/**
 * Maximum flow (Dinic) on a small graph with real capacities. Used to share people's hours across the work centers
 * they are qualified for: source → person (their hours) → work center (if qualified) → sink (its operator load).
 */
export function maxFlow(n: number, edges: { from: number; to: number; cap: number }[], s: number, t: number) {
  const to: number[] = []; const cap: number[] = []; const head = Array<number>(n).fill(-1); const next: number[] = [];
  const add = (u: number, v: number, c: number) => { to.push(v); cap.push(c); next.push(head[u]!); head[u] = to.length - 1; };
  const ids = edges.map((e) => { add(e.from, e.to, e.cap); add(e.to, e.from, 0); return to.length - 2; });
  let total = 0;
  const level = Array<number>(n);
  for (;;) {
    level.fill(-1); level[s] = 0;
    const q = [s];
    for (let i = 0; i < q.length; i++) for (let e = head[q[i]!]!; e !== -1; e = next[e]!) if (cap[e]! > 1e-9 && level[to[e]!]! < 0) { level[to[e]!] = level[q[i]!]! + 1; q.push(to[e]!); }
    if (level[t]! < 0) break;
    const it = [...head];
    const dfs = (u: number, f: number): number => {
      if (u === t) return f;
      for (; it[u]! !== -1; it[u] = next[it[u]!]!) {
        const e = it[u]!; const v = to[e]!;
        if (cap[e]! > 1e-9 && level[v] === level[u]! + 1) {
          const d = dfs(v, Math.min(f, cap[e]!));
          if (d > 1e-9) { cap[e]! -= d; cap[e ^ 1]! += d; return d; }
        }
      }
      return 0;
    };
    for (let f = dfs(s, Infinity); f > 1e-9; f = dfs(s, Infinity)) total += f;
  }
  return { total, flows: ids.map((id, i) => edges[i]!.cap - cap[id]!) };
}

/**
 * Qualified labor per work center and month. A person counts for a work center when, on the first day of the month
 * (today in the current month), they hold every qualification its machines require to operate. Their hours are
 * demonstrated (approved timesheets) or assumed; one person's hours are shared across all the work centers they can
 * run, so the check is a maximum flow rather than a per-center sum. Work centers without operate requirements are not
 * labor-constrained here.
 */
export function planLabor(input: PlanInput, workCenters: { id: string; code: string; cells: { month: string; required: number }[] }[], assumptions: Set<string>) {
  const people = input.people ?? [];
  const req = new Map(input.workCenters.map((w) => [w.id, w]));
  const constrained = workCenters.filter((w) => (req.get(w.id)?.requiredQualifications ?? []).length);
  if (!constrained.length) {
    if (input.workCenters.length) assumptions.add('No work center requires a qualification to operate its machines; qualified labor is not checked');
    return null;
  }
  const unconstrained = workCenters.filter((w) => !(req.get(w.id)?.requiredQualifications ?? []).length).map((w) => w.code);
  if (unconstrained.length) assumptions.add(`${unconstrained.join(', ')}: no operating qualification required; their labor is not checked`);
  if (people.some((p) => p.hoursPerWeek == null)) assumptions.add(`${DEFAULT_HOURS_PER_WEEK} hours a week assumed for people with fewer than 4 approved timesheets in the last 8 weeks`);
  const holds = (p: Person, quals: string[], day: string) => quals.every((q) => p.qualifications.some((x) => x.id === q && x.effectiveOn <= day && (x.expiresOn == null || x.expiresOn > day)));
  const dayOf = (m: string) => (`${m}-01` < input.today ? input.today : `${m}-01`);
  const cells = new Map(constrained.map((w) => [w.id, [] as { month: string; required: number; available: number; covered: number; short: number; qualified: number }[]]));
  input.months.forEach((m, k) => {
    const day = dayOf(m);
    const weeks = daysIn(m) / 7; // whole months, as machine capacity
    const qual = new Map(constrained.map((w) => [w.id, people.filter((p) => holds(p, req.get(w.id)!.requiredQualifications!, day))]));
    const involved = [...new Set([...qual.values()].flat())];
    const P = new Map(involved.map((p, i) => [p.id, 1 + i]));
    const W = new Map(constrained.map((w, i) => [w.id, 1 + involved.length + i]));
    const sink = 1 + involved.length + constrained.length;
    const need = new Map(constrained.map((w) => [w.id, w.cells[k]!.required * (req.get(w.id)!.laborRatio ?? 1)]));
    const edges = [
      ...involved.map((p) => ({ from: 0, to: P.get(p.id)!, cap: (p.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK) * weeks })),
      ...constrained.flatMap((w) => qual.get(w.id)!.map((p) => ({ from: P.get(p.id)!, to: W.get(w.id)!, cap: Infinity }))),
      ...constrained.map((w) => ({ from: W.get(w.id)!, to: sink, cap: need.get(w.id)! })),
    ];
    const f = maxFlow(sink + 1, edges, 0, sink);
    const sinkFlows = f.flows.slice(edges.length - constrained.length);
    constrained.forEach((w, i) => {
      const required = need.get(w.id)!; const covered = sinkFlows[i]!;
      const available = qual.get(w.id)!.reduce((s, p) => s + (p.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK) * weeks, 0);
      cells.get(w.id)!.push({ month: m, required: r1(required), available: r1(available), covered: r1(covered), short: r1(Math.max(0, required - covered)), qualified: qual.get(w.id)!.length });
    });
  });
  // Qualifications lapsing in the horizon that leave a work center with fewer qualified people.
  const end = addDays(`${input.months[input.months.length - 1]}-01`, daysIn(input.months[input.months.length - 1]!) - 1);
  const lapses = [];
  for (const w of constrained) {
    const quals = req.get(w.id)!.requiredQualifications!;
    for (const p of people.filter((x) => holds(x, quals, input.today))) {
      for (const q of p.qualifications.filter((x) => quals.includes(x.id) && x.expiresOn && x.expiresOn <= end)) {
        lapses.push({ workCenter: w.code, person: p.name, qualification: q.code, expiresOn: q.expiresOn!, leaves: people.filter((x) => holds(x, quals, q.expiresOn!)).length });
      }
    }
  }
  return {
    workCenters: constrained.map((w) => {
      const c = cells.get(w.id)!;
      const now = c[0]!.qualified;
      return { id: w.id, code: w.code, qualifications: req.get(w.id)!.requiredQualifications!.map((q) => input.qualificationCodes?.[q] ?? q),
        laborRatio: req.get(w.id)!.laborRatio ?? 1, qualifiedNow: now, singlePoint: now <= 1, cells: c, shortMonths: c.filter((x) => x.short > 0).length };
    }),
    lapses: lapses.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)),
  };
}
