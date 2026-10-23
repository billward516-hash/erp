import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import {
  acknowledgeHandbook, acknowledgePolicy, createPolicy, expenseRules, getPolicy, handbook, installTemplates, listPolicies, myPendingPolicies, publishPolicy, saveDraft,
  saveExpenseCategory, saveExpensePolicy,
} from '../src/modules/policies/service.js';
import { placeholders, POLICY_TEMPLATES } from '../src/modules/policies/templates.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let hr: Actor;
const notices = async (who: Actor, kind: string) => (await db().query('SELECT title FROM notification WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [who.userId, kind])).rows.map((r) => r.title);

beforeAll(async () => {
  w = await makeWorld('pol');
  const u = await createUserWithToken(db(), w.tenantId, { email: `hr-${Date.now()}@pol.example`, displayName: 'Hana HR', roles: [{ role: 'hr_manager', facility: null }] });
  hr = (await loadActor(w.tenantId, u.userId))!;
});
afterAll(closePools);

describe('templates', () => {
  it('every template has placeholders to complete, and the expense policy shows the live rules', () => {
    for (const t of POLICY_TEMPLATES) expect(placeholders(t.body).length, t.key).toBeGreaterThan(0);
    expect(POLICY_TEMPLATES.find((t) => t.key === 'expense.travel')!.body).toContain('{{expense_rules}}');
    expect(placeholders('[[A]] and [[B]] then [[A]]')).toEqual(['[[A]]', '[[B]]']);
  });
});

describe('the handbook from templates to acknowledgement', () => {
  let welcome: any;
  it('installs the templates once, as drafts only HR sees', async () => {
    const r = await asActor(hr, (tx) => installTemplates(tx, hr));
    expect(r.created).toHaveLength(POLICY_TEMPLATES.length);
    expect((await asActor(hr, (tx) => installTemplates(tx, hr))).created).toEqual([]);
    await expect(asActor(w.techA, (tx) => installTemplates(tx, w.techA))).rejects.toThrow(/policies.manage/);
    expect(await asActor(w.techA, (tx) => listPolicies(tx, w.techA))).toEqual([]);
    const mine = await asActor(hr, (tx) => listPolicies(tx, hr, { category: 'handbook' }));
    welcome = mine.find((p) => p.title === 'Welcome and about us');
    expect(welcome.draft_placeholders).toBeGreaterThan(0);
  });

  it('refuses to publish while placeholders remain, then publishes and asks everyone to acknowledge', async () => {
    await expect(asActor(hr, (tx) => publishPolicy(tx, hr, welcome.id))).rejects.toThrow(/complete the \d+ placeholders first: \[\[Company name\]\]/);
    const p = await asActor(hr, (tx) => getPolicy(tx, hr, welcome.id));
    const body = p.draft.body.replaceAll('[[Company name]]', 'Acme Parts').replace(/\[\[Two or three sentences[^\]]*\]\]/, 'We machine valve housings for hydraulics makers.')
      .replace('[[name or role, e.g. HR Manager]]', 'the HR Manager');
    await asActor(hr, (tx) => saveDraft(tx, hr, welcome.id, { body }));
    expect((await asActor(hr, (tx) => publishPolicy(tx, hr, welcome.id, { effectiveOn: '2026-11-01' })))).toEqual({ revision: 1, acknowledgementRequested: true });
    expect(await notices(w.techA, 'policy.published')).toEqual(['Please read and acknowledge: Welcome and about us']);
    const seen = await asActor(w.techA, (tx) => getPolicy(tx, w.techA, welcome.id));
    expect(seen).toMatchObject({ acknowledged: false, draft: null, current: { revision: 1, effective_on: '2026-11-01' } });
    expect(seen.current.body).toContain('Welcome to Acme Parts.');
    expect((await asActor(w.techA, (tx) => myPendingPolicies(tx, w.techA))).map((x) => x.title)).toEqual(['Welcome and about us']);
    // The published text is the record: it cannot be edited in place.
    await expect(db().query(`UPDATE policy_version SET body = 'changed' WHERE policy_id = $1 AND status = 'published'`, [welcome.id])).rejects.toThrow(/cannot be edited/);
  });

  it('acknowledgements are kept through a minor revision and asked again for a material one', async () => {
    await asActor(w.techA, (tx) => acknowledgeHandbook(tx, w.techA));
    expect((await asActor(w.techA, (tx) => getPolicy(tx, w.techA, welcome.id))).acknowledged).toBe(true);
    let status = (await asActor(hr, (tx) => getPolicy(tx, hr, welcome.id))).status;
    expect(status.acknowledged).toBe(1);
    expect(status.outstanding.map((x: any) => x.name)).toContain('Hana HR');
    // Minor: typo fixed, no re-acknowledgement.
    const p = await asActor(hr, (tx) => getPolicy(tx, hr, welcome.id));
    await asActor(hr, (tx) => saveDraft(tx, hr, welcome.id, { body: `${p.current.body}\n`, requiresReack: false }));
    await expect(asActor(hr, (tx) => publishPolicy(tx, hr, welcome.id))).rejects.toThrow(/say what changed/);
    await asActor(hr, (tx) => saveDraft(tx, hr, welcome.id, { body: p.current.body.replace('Questions go to', 'Questions about it go to'), changeSummary: 'Wording' }));
    expect((await asActor(hr, (tx) => publishPolicy(tx, hr, welcome.id))).acknowledgementRequested).toBe(false);
    expect((await asActor(w.techA, (tx) => getPolicy(tx, w.techA, welcome.id))).acknowledged).toBe(true);
    // Material: everyone acknowledges again.
    await asActor(hr, (tx) => saveDraft(tx, hr, welcome.id, { body: `${p.current.body}\n\n## Our values\n\nSafety first.`, changeSummary: 'Added our values', requiresReack: true }));
    await asActor(hr, (tx) => publishPolicy(tx, hr, welcome.id));
    expect((await asActor(w.techA, (tx) => getPolicy(tx, w.techA, welcome.id))).acknowledged).toBe(false);
    await asActor(w.techA, (tx) => acknowledgePolicy(tx, w.techA, welcome.id));
    const h = await asActor(w.techA, (tx) => handbook(tx, w.techA));
    expect(h.sections.map((s: any) => [s.title, s.revision, s.acknowledged])).toEqual([['Welcome and about us', 3, true]]);
    expect(h.pending).toBe(0);
    status = (await asActor(hr, (tx) => getPolicy(tx, hr, welcome.id))).status;
    expect(status.acknowledged).toBe(1);
  });

  it('a site policy applies only to people at that site', async () => {
    const p = await asActor(hr, (tx) => createPolicy(tx, hr, { title: 'Plant B parking', category: 'other', facilityId: w.facilities.B!, body: '## Parking\n\nUse lot 2.' }));
    await asActor(hr, (tx) => publishPolicy(tx, hr, p.id));
    expect((await asActor(w.operatorB, (tx) => listPolicies(tx, w.operatorB))).map((x) => x.title)).toContain('Plant B parking');
    expect((await asActor(w.techA, (tx) => listPolicies(tx, w.techA))).map((x) => x.title)).not.toContain('Plant B parking');
    await expect(asActor(w.techA, (tx) => acknowledgePolicy(tx, w.techA, p.id))).rejects.toThrow(/another site/);
  });
});

describe('expense policy rules', () => {
  it('starts with categories and no limits; HR sets them and the policy shows them', async () => {
    const r0 = await asActor(w.techA, (tx) => expenseRules(tx));
    expect(r0.policy).toMatchObject({ receipt_required_over: 25, mileage_rate: null });
    expect(r0.categories.map((c: any) => c.code)).toContain('MILEAGE');
    expect(r0.categories.every((c: any) => c.limit_per_item == null)).toBe(true);
    await expect(asActor(w.techA, (tx) => saveExpensePolicy(tx, w.techA, { receiptRequiredOver: 10 }))).rejects.toThrow(/policies.manage/);
    await asActor(hr, (tx) => saveExpensePolicy(tx, hr, { receiptRequiredOver: 25, mileageRate: 0.7, submitWithinDays: 60 }));
    const meals = r0.categories.find((c: any) => c.code === 'MEALS');
    await expect(asActor(hr, (tx) => saveExpenseCategory(tx, hr, { id: meals.id, code: 'MEALS', name: meals.name, limitPerItem: 80, limitPerDay: 75 }))).rejects.toThrow(/above the daily limit/);
    await asActor(hr, (tx) => saveExpenseCategory(tx, hr, { id: meals.id, code: 'MEALS', name: meals.name, limitPerDay: 75, accountKey: 'travel_expense' }));
    const r1 = await asActor(w.techA, (tx) => expenseRules(tx));
    expect(r1.policy).toMatchObject({ mileage_rate: 0.7, submit_within_days: 60 });
    expect(r1.categories.find((c: any) => c.code === 'MEALS').limit_per_day).toBe(75);
    const exp = (await asActor(hr, (tx) => listPolicies(tx, hr, { category: 'expense' })))[0];
    expect((await asActor(hr, (tx) => getPolicy(tx, hr, exp.id))).expenseRules.policy.mileage_rate).toBe(0.7);
  });
});
