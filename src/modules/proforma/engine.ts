/**
 * Opportunity pro forma engine (D-162): turns a set of driver lines into a monthly projection, then the figures a
 * decision needs — annual profit and loss, cash, payback, peak funding, NPV, IRR — for each scenario, and a sensitivity
 * ranking of what moves the result. Pure: no database, so the page, the report and the tests compute the same numbers.
 *
 * Simplifications, stated on the page: straight-line depreciation; tax on positive profit after losses carried
 * forward; working capital as days of revenue, not released at the end; cash flows discounted at the end of each month.
 */
export type Section = 'revenue' | 'cost_of_sales' | 'operating' | 'capital';
export type Method = 'units_price' | 'fixed_monthly' | 'pct_of_revenue' | 'headcount' | 'one_time';

export interface Line {
  section: Section; label: string; method: Method;
  /** Price per unit, monthly amount, percent of revenue, annual cost per person, or the one-time amount. */
  amount: number;
  /** Units per month or people; unused by the other methods. */
  qty?: number | null;
  /** Annual growth, compounding at each anniversary of the line's start. */
  growthPct?: number | null;
  /** Months after the model start when the line begins (0 = the first month), and optionally when it stops (exclusive). */
  startMonth?: number | null; endMonth?: number | null;
  /** Revenue builds up evenly over this many months before reaching the full rate. */
  rampMonths?: number | null;
  /** Capital only: years it is depreciated over. */
  lifeYears?: number | null;
}

export interface Assumptions { years: number; discountRatePct: number; taxRatePct: number; workingCapitalDays: number }
export interface Scenario { revenuePct: number; costPct: number; capitalPct: number; delayMonths: number }
export type ScenarioKey = 'low' | 'base' | 'high';
export const DEFAULT_SCENARIOS: Record<ScenarioKey, Scenario> = {
  low: { revenuePct: -20, costPct: 10, capitalPct: 15, delayMonths: 3 },
  base: { revenuePct: 0, costPct: 0, capitalPct: 0, delayMonths: 0 },
  high: { revenuePct: 15, costPct: -5, capitalPct: 0, delayMonths: 0 },
};

export const METHODS: Record<Section, Method[]> = {
  revenue: ['units_price', 'fixed_monthly'],
  cost_of_sales: ['pct_of_revenue', 'units_price', 'fixed_monthly'],
  operating: ['fixed_monthly', 'headcount', 'pct_of_revenue', 'one_time'],
  capital: ['one_time'],
};

export interface Month { revenue: number; costOfSales: number; operating: number; depreciation: number; tax: number; capital: number; workingCapital: number; cash: number }
export interface Year { year: number; revenue: number; costOfSales: number; grossProfit: number; operating: number; ebitda: number; depreciation: number; ebit: number; tax: number;
  netIncome: number; capital: number; workingCapital: number; cashFlow: number; endingCash: number }
export interface Result {
  months: Month[]; years: Year[];
  totals: { revenue: number; ebitda: number; netIncome: number; capital: number; cashFlow: number };
  npv: number; irrPct: number | null;
  /** Months until cumulative cash turns positive and stays so (null if it never does); 0 when it is never negative. */
  paybackMonths: number | null;
  /** First month with revenue whose operating profit (EBITDA) is positive. */
  breakevenMonth: number | null;
  peakFunding: number;
  grossMarginPct: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function lineMonth(l: Line, m: number, revenueAt: (m: number) => number, s: Scenario): number {
  const delay = l.section === 'revenue' ? s.delayMonths : 0;
  const start = (l.startMonth ?? 0) + delay;
  const end = l.endMonth == null ? Infinity : l.endMonth + delay;
  if (m < start || m >= end) return 0;
  const growth = (1 + (l.growthPct ?? 0) / 100) ** Math.floor((m - start) / 12);
  const ramp = l.section === 'revenue' && (l.rampMonths ?? 0) > 0 ? Math.min(1, (m - start + 1) / l.rampMonths!) : 1;
  const scale = l.section === 'revenue' ? 1 + s.revenuePct / 100 : l.section === 'capital' ? 1 + s.capitalPct / 100 : l.method === 'pct_of_revenue' ? 1 : 1 + s.costPct / 100;
  switch (l.method) {
    case 'units_price': return (l.qty ?? 0) * l.amount * growth * ramp * scale;
    case 'fixed_monthly': return l.amount * growth * ramp * scale;
    case 'headcount': return ((l.qty ?? 0) * l.amount * growth * scale) / 12;
    case 'pct_of_revenue': return (revenueAt(m) * l.amount) / 100;
    case 'one_time': return m === start ? l.amount * scale : 0;
  }
}

/** Net present value of monthly cash flows at an annual rate, each discounted at the end of its month. */
export function npvOf(cash: number[], annualRatePct: number) {
  const monthly = (1 + annualRatePct / 100) ** (1 / 12) - 1;
  return cash.reduce((s, c, i) => s + c / (1 + monthly) ** (i + 1), 0);
}

/** Annual internal rate of return by bisection, or null when the flows never change sign (no rate makes NPV zero). */
export function irrOf(cash: number[]): number | null {
  if (!cash.some((c) => c < 0) || !cash.some((c) => c > 0)) return null;
  let lo = -99; let hi = 1000;
  const f = (r: number) => npvOf(cash, r);
  if (Math.sign(f(lo)) === Math.sign(f(hi))) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}

export function project(lines: Line[], a: Assumptions, s: Scenario = DEFAULT_SCENARIOS.base): Result {
  const n = Math.max(1, Math.min(10, Math.round(a.years))) * 12;
  const rev = new Array<number>(n).fill(0);
  for (let m = 0; m < n; m++) for (const l of lines) if (l.section === 'revenue') rev[m]! += lineMonth(l, m, () => 0, s);
  const revenueAt = (m: number) => rev[m] ?? 0;
  const months: Month[] = [];
  // Depreciation: each capital outlay spread evenly over its life from the month after it is spent.
  const dep = new Array<number>(n).fill(0);
  const capital = new Array<number>(n).fill(0);
  for (const l of lines.filter((x) => x.section === 'capital')) {
    for (let m = 0; m < n; m++) {
      const c = lineMonth(l, m, revenueAt, s);
      if (!c) continue;
      capital[m]! += c;
      const life = Math.max(1, Math.round((l.lifeYears ?? 5) * 12));
      for (let k = m + 1; k < Math.min(n, m + 1 + life); k++) dep[k]! += c / life;
    }
  }
  let lossCarried = 0; let wcPrev = 0; let cum = 0;
  for (let m = 0; m < n; m++) {
    let cos = 0; let opex = 0;
    for (const l of lines) {
      if (l.section === 'cost_of_sales') cos += lineMonth(l, m, revenueAt, s);
      else if (l.section === 'operating') opex += lineMonth(l, m, revenueAt, s);
    }
    const ebitda = rev[m]! - cos - opex;
    const ebit = ebitda - dep[m]!;
    // Losses carry forward against later profit before any tax is due.
    let taxable = ebit;
    if (taxable < 0) { lossCarried += -taxable; taxable = 0; } else { const used = Math.min(lossCarried, taxable); lossCarried -= used; taxable -= used; }
    const tax = (taxable * a.taxRatePct) / 100;
    const wc = (rev[m]! * 12 * a.workingCapitalDays) / 365;
    const wcChange = wc - wcPrev; wcPrev = wc;
    const cash = ebitda - tax - capital[m]! - wcChange;
    cum += cash;
    months.push({ revenue: rev[m]!, costOfSales: cos, operating: opex, depreciation: dep[m]!, tax, capital: capital[m]!, workingCapital: wcChange, cash });
  }
  const years: Year[] = [];
  let ending = 0;
  for (let y = 0; y < n / 12; y++) {
    const ms = months.slice(y * 12, y * 12 + 12);
    const sum = (k: keyof Month) => ms.reduce((t, x) => t + x[k], 0);
    const revenue = sum('revenue'); const costOfSales = sum('costOfSales'); const operating = sum('operating'); const depreciation = sum('depreciation'); const tax = sum('tax');
    const ebitda = revenue - costOfSales - operating; const ebit = ebitda - depreciation; const cashFlow = sum('cash');
    ending += cashFlow;
    years.push({ year: y + 1, revenue: r2(revenue), costOfSales: r2(costOfSales), grossProfit: r2(revenue - costOfSales), operating: r2(operating), ebitda: r2(ebitda), depreciation: r2(depreciation),
      ebit: r2(ebit), tax: r2(tax), netIncome: r2(ebit - tax), capital: r2(sum('capital')), workingCapital: r2(sum('workingCapital')), cashFlow: r2(cashFlow), endingCash: r2(ending) });
  }
  const cash = months.map((x) => x.cash);
  let running = 0; let minCum = 0; let lastNegative = -1;
  cash.forEach((c, i) => { running += c; if (running < -0.005) lastNegative = i; minCum = Math.min(minCum, running); });
  const paybackMonths = lastNegative === -1 ? 0 : lastNegative === n - 1 ? null : lastNegative + 2; // the month cumulative cash is back to zero or above
  const be = months.findIndex((x) => x.revenue > 0 && x.revenue - x.costOfSales - x.operating > 0);
  const totRevenue = years.reduce((t, y) => t + y.revenue, 0);
  const totCos = years.reduce((t, y) => t + y.costOfSales, 0);
  return {
    months, years,
    totals: { revenue: r2(totRevenue), ebitda: r2(years.reduce((t, y) => t + y.ebitda, 0)), netIncome: r2(years.reduce((t, y) => t + y.netIncome, 0)), capital: r2(years.reduce((t, y) => t + y.capital, 0)),
      cashFlow: r2(cum) },
    npv: r2(npvOf(cash, a.discountRatePct)), irrPct: irrOf(cash), paybackMonths, breakevenMonth: be === -1 ? null : be + 1, peakFunding: r2(-minCum),
    grossMarginPct: totRevenue ? Math.round((1000 * (totRevenue - totCos)) / totRevenue) / 10 : null,
  };
}

export interface Driver { label: string; low: number; high: number; swing: number }

/**
 * What moves the result: NPV with each driver pushed down and up on its own, ranked by the spread. The drivers are the
 * scenario levers (revenue, costs, capital, a launch delay) and each of the three largest revenue lines.
 */
export function sensitivity(lines: Line[], a: Assumptions, s: Scenario = DEFAULT_SCENARIOS.base): Driver[] {
  const at = (x: Partial<Scenario>, ls = lines) => project(ls, a, { ...s, ...x }).npv;
  const out: Driver[] = [
    { label: 'Revenue ±20%', low: at({ revenuePct: s.revenuePct - 20 }), high: at({ revenuePct: s.revenuePct + 20 }) },
    { label: 'Costs ±20%', low: at({ costPct: s.costPct + 20 }), high: at({ costPct: s.costPct - 20 }) },
    { label: 'Capital ±20%', low: at({ capitalPct: s.capitalPct + 20 }), high: at({ capitalPct: s.capitalPct - 20 }) },
    { label: 'Launch 6 months later / on time', low: at({ delayMonths: s.delayMonths + 6 }), high: at({}) },
    { label: `Discount rate ${a.discountRatePct + 2}% / ${Math.max(0, a.discountRatePct - 2)}%`, low: project(lines, { ...a, discountRatePct: a.discountRatePct + 2 }, s).npv,
      high: project(lines, { ...a, discountRatePct: Math.max(0, a.discountRatePct - 2) }, s).npv },
  ].map((d) => ({ ...d, swing: 0 }));
  const base = project(lines, a, s);
  const revLines = lines.map((l, i) => ({ l, i, total: l.section === 'revenue' ? project([l], a, s).totals.revenue : 0 })).filter((x) => x.total > 0).sort((x, y) => y.total - x.total).slice(0, 3);
  for (const { l, i } of revLines) {
    const scaled = (f: number) => lines.map((x, j) => (j === i ? { ...x, amount: x.amount * f } : x));
    out.push({ label: `${l.label} ±20%`, low: at({}, scaled(0.8)), high: at({}, scaled(1.2)), swing: 0 });
  }
  return out.map((d) => ({ ...d, low: r2(d.low), high: r2(d.high), swing: r2(Math.abs(d.high - d.low)) })).filter((d) => d.swing > 0 || base.npv === 0).sort((x, y) => y.swing - x.swing);
}
