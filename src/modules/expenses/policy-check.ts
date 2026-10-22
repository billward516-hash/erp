/**
 * Expense policy checks (D-129, D-131). Pure: the same lines and rules always give the same findings. A `block`
 * finding stops submission until the line is fixed; an `explain` finding needs an explanation on the line, which the
 * approvers see next to the flag.
 */
export interface Category { id: string; code: string; name: string; kind: 'amount' | 'mileage'; limit_per_item: number | null; limit_per_day: number | null;
  receipt_required_over: number | null; needs_attendees: boolean; active: boolean }
export interface Policy { receipt_required_over: number; mileage_rate: number | null; submit_within_days: number | null }
export interface Line { id?: string; line_no: number; spent_on: string; category_id: string; merchant: string | null; description: string | null; amount: number;
  miles: number | null; attendees: string | null; explanation: string | null; has_receipt: boolean }
export interface Finding { code: string; severity: 'block' | 'explain'; message: string }
/** Earlier claims by the same person, to catch the same expense claimed twice. */
export interface PriorLine { report_number: string; spent_on: string; amount: number; merchant: string | null }

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function checkLines(lines: Line[], categories: Category[], policy: Policy, today: string, prior: PriorLine[] = []): Map<number, Finding[]> {
  const cats = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<number, Finding[]>(lines.map((l) => [l.line_no, []]));
  const add = (l: Line, f: Finding) => out.get(l.line_no)!.push(f);
  // Daily totals per category, for per-day limits.
  const day = new Map<string, number>();
  for (const l of lines) day.set(`${l.category_id}|${l.spent_on}`, (day.get(`${l.category_id}|${l.spent_on}`) ?? 0) + l.amount);
  for (const l of lines) {
    const c = cats.get(l.category_id);
    if (!c || !c.active) { add(l, { code: 'category', severity: 'block', message: 'choose an active expense category' }); continue; }
    if (l.spent_on > today) add(l, { code: 'future', severity: 'block', message: 'the date is in the future' });
    if (c.kind === 'mileage') {
      if (!policy.mileage_rate) add(l, { code: 'mileage_rate', severity: 'block', message: 'mileage cannot be claimed until the company sets a mileage rate' });
      if (!l.miles) add(l, { code: 'miles', severity: 'block', message: 'enter the miles driven' });
      if (!l.description?.trim()) add(l, { code: 'trip', severity: 'block', message: 'say where you drove (from, to and why)' });
    } else if (!(l.amount > 0)) add(l, { code: 'amount', severity: 'block', message: 'enter the amount' });
    if (c.needs_attendees && !l.attendees?.trim()) add(l, { code: 'attendees', severity: 'block', message: `${c.name}: list who attended and the business reason` });
    if (c.code === 'OTHER' && !l.description?.trim()) add(l, { code: 'describe', severity: 'block', message: 'describe what this expense was for' });
    if (c.kind !== 'mileage') {
      const threshold = c.receipt_required_over ?? policy.receipt_required_over;
      if (l.amount > threshold && !l.has_receipt) add(l, { code: 'receipt', severity: 'explain', message: `receipt required over ${usd(threshold)}; attach it, or explain why there is none` });
      if (c.limit_per_item != null && l.amount > c.limit_per_item) add(l, { code: 'over_item', severity: 'explain', message: `${usd(l.amount - c.limit_per_item)} over the ${usd(c.limit_per_item)} limit per expense for ${c.name}` });
      const daily = day.get(`${l.category_id}|${l.spent_on}`)!;
      if (c.limit_per_day != null && daily > c.limit_per_day) add(l, { code: 'over_day', severity: 'explain', message: `${c.name} on ${l.spent_on} total ${usd(daily)}, over the ${usd(c.limit_per_day)} daily limit` });
    }
    if (policy.submit_within_days && daysBetween(l.spent_on, today) > policy.submit_within_days) {
      add(l, { code: 'late', severity: 'explain', message: `older than the ${policy.submit_within_days}-day limit for claiming` });
    }
    const merchant = (l.merchant ?? '').trim().toLowerCase();
    const dupInReport = merchant && lines.some((o) => o.line_no !== l.line_no && o.spent_on === l.spent_on && o.amount === l.amount && (o.merchant ?? '').trim().toLowerCase() === merchant);
    const dupBefore = merchant ? prior.find((p) => p.spent_on === l.spent_on && p.amount === l.amount && (p.merchant ?? '').trim().toLowerCase() === merchant) : undefined;
    if (dupInReport) add(l, { code: 'duplicate', severity: 'explain', message: 'the same date, amount and merchant appear twice in this report' });
    else if (dupBefore) add(l, { code: 'duplicate', severity: 'explain', message: `looks like the same expense on ${dupBefore.report_number}` });
  }
  return out;
}

/** Whether a line's findings stop submission: anything blocking, or exceptions without an explanation. */
export function lineReady(findings: Finding[], explanation: string | null) {
  if (findings.some((f) => f.severity === 'block')) return false;
  return !findings.some((f) => f.severity === 'explain') || (explanation?.trim().length ?? 0) >= 5;
}
