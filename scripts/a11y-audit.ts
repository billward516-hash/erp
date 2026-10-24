/**
 * Accessibility audit: runs axe-core (WCAG 2.0/2.1 A and AA rules) on the main pages as several demo users, in light
 * and dark color schemes, against a seeded server. Fails on any violation of serious or critical impact; lists the rest.
 *
 *   BASE_URL=http://localhost:3011 npx tsx scripts/a11y-audit.ts
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3011';
const tokens: Record<string, string> = JSON.parse(await readFile('.storage/dev-tokens.json', 'utf8'));
const token = (prefix: string) => Object.entries(tokens).find(([k]) => k.startsWith(prefix))![1];
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** A path, or a path then the text of a row to open (detail pages). */
const VISITS: [string, (string | [string, string])[]][] = [
  ['dana', ['/cleanrooms', '/chemicals', '/chemicals?tab=preparations', '/chemicals?tab=parts', '/chemicals?tab=storage', '/chemicals?tab=limits', ['/cleanrooms', 'Smoke fill suite'], '/implementation', '/documents?bulk=1', '/access', '/jobs', '/assets', '/work-orders']],
  ['priya', ['/', ['/', 'Deburr cross-drilled ports on HSG-100'], '/work-orders', ['/work-orders', 'Spindle vibration above 6k rpm'], '/assets', ['/assets', 'HMC-201'], '/training', '/time', '/outbox']],
  ['marcus', ['/documents', '/documents/new', ['/documents', 'Component cleanliness requirements'], ['/documents', 'Coolant concentrate change on the HMC-201'], ['/documents', 'CMP-01 oil & separator change'], ['/assets', 'Haas VF-4'], '/pm', '/inventory', ['/inventory?tab=lots', 'TC-24-0917'], '/reports/lot-status', '/inventory?tab=counts', '/purchasing', '/approvals', '/reports', '/reports/asset-availability', '/changes']],
  ['carlos', ['/planning', '/production', '/production/floor', '/shift-log', ['/shift-log', 'Acknowledged']]],
  ['sam', ['/capa', '/capa/new', '/reviews?status=all', '/quality', '/quality?tab=spc', ['/quality?tab=spc', 'HSG-BORE'], ['/quality?tab=spc', 'HSG-LEAK'], ['/quality?tab=capas', 'Burrs in cross-drilled port (Lakeshore 8D)'], '/quality?tab=calibration', '/safety']],
  ['alex', ['/proforma', '/proforma/new', ['/proforma', 'Second 5-axis cell for the Lakeshore program'], '/improvements', ['/improvements', 'Quick-change fixture plates on the VMCs'], ['/improvements', 'Balance-check tool holders before use on HMC-201']]],
  ['lena', ['/performance?tab=all', '/performance?tab=settings', '/policies', '/policies?tab=all', '/policies?tab=expenses', ['/policies?tab=all', 'Performance and discipline'], ['/policies?tab=all', 'Expense and travel policy']]],
  ['tolu', ['/', '/people', '/search?q=forklift', '/news']],
  ['priya', ['/expenses', ['/expenses', 'Hydraulics seminar, Cincinnati'], ['/expenses', 'Grundfos pump course, Columbus']]],
  ['ana', ['/expenses?tab=all', '/expenses?tab=rules']],
  ['kai', ['/', '/books', '/books?tab=banking', '/books?tab=accounts', '/books?tab=journal', '/books?tab=statements', '/books?tab=reconcile', '/books?tab=settings', '/receivables?tab=new', ['/receivables?tab=credits', 'CM-'], '/ap/new']],
  ['morgan', ['/budgets', '/budgets?tab=budgets', '/budgets?tab=categories', ['/budgets?tab=budgets', `${new Date().getUTCFullYear() + 1} operating budget`], ['/budgets?tab=budgets', `${new Date().getUTCFullYear()} operating budget`]]],
  ['dana', ['/archives', ['/archives', 'Bring records back'], '/news', '/sign-in-settings', '/features', '/reminders', '/retention', '/sites', '/imports', '/crm', '/sales', '/receivables', '/ap', '/continuity', '/integrations', '/leasing', '/stores', ['/purchasing', 'Supplier performance']]],
];
VISITS.push(['dana', ['/lab', '/lab?tab=methods', '/lab?tab=investigations', ['/lab', 'Lab smoke sample']]]); // samples and test results (D-184D); the smoke test leaves the sample

async function signIn(page: Page, who: string) {
  await page.goto(BASE);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(BASE);
  await page.click('summary:has-text("Development sign-in")');
  await page.fill('#token', token(who));
  await page.click('button:has-text("Sign in with token")');
  await page.waitForSelector('nav[aria-label="Main"]');
}

type Finding = { id: string; impact: string; help: string; url: string; scheme: string; nodes: string[] };
const findings: Finding[] = [];
let audited = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
for (const scheme of ['light', 'dark'] as const) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: scheme, bypassCSP: true }); // axe-core is injected inline, which the app's CSP (D-150) rightly refuses
  const page = await context.newPage();
  // Login page first, signed out.
  await page.goto(BASE);
  for (const [who, paths] of [['', ['/']] as [string, string[]], ...VISITS]) {
    if (who) await signIn(page, who);
    for (const step of paths) {
      const [p, open] = Array.isArray(step) ? step : [step, null];
      if (who || p !== '/') await page.goto(`${BASE}${p}`);
      await page.waitForLoadState('networkidle');
      // A record the smoke test already consumed (for example an acknowledged reading) is simply not there to open.
      if (open && await page.getByText(open).count()) { await page.getByText(open).first().click(); await page.waitForLoadState('networkidle'); }
      await page.addScriptTag({ path: axePath });
      const res = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
      audited++;
      for (const v of res.violations) findings.push({ id: v.id, impact: v.impact, help: v.help, url: `${who || 'signed out'} ${p}${open ? ` → ${open}` : ''}`, scheme, nodes: v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')) });
    }
  }
  await context.close();
}
await browser.close();

const byRule = new Map<string, Finding[]>();
for (const f of findings) byRule.set(f.id, [...(byRule.get(f.id) ?? []), f]);
for (const [id, fs] of byRule) {
  console.log(`${fs[0]!.impact.padEnd(8)} ${id}: ${fs[0]!.help} (${fs.length} page${fs.length === 1 ? '' : 's'})`);
  for (const f of fs.slice(0, 4)) console.log(`           ${f.scheme} ${f.url}: ${f.nodes.join(' | ')}`);
}
const blocking = findings.filter((f) => f.impact === 'serious' || f.impact === 'critical');
console.log(`\n${audited} page views audited; ${findings.length} violation(s) on ${new Set(findings.map((f) => f.url + f.scheme)).size} of them; ${blocking.length} serious or critical`);
if (blocking.length) process.exit(1);
