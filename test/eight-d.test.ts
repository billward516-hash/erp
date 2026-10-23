import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor, loadActor } from '../src/platform/auth/actor.js';
import type { Actor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { createUserWithToken } from '../src/platform/tenancy/provision.js';
import { addReadAcross, addTeamMember, decideReadAcross, disciplines, recognizeTeam } from '../src/modules/quality/eight-d.js';
import { renderEightDPdf } from '../src/modules/quality/eight-d-pdf.js';
import { addAction, advanceCapa, completeAction, createCapa, getCapa, listCapas, updateCapa, verifyCapa } from '../src/modules/quality/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
let lead: Actor; let member: Actor;
const notices = async (who: Actor, kind: string) => (await db().query('SELECT title FROM notification WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [who.userId, kind])).rows.map((r) => r.title);

beforeAll(async () => {
  w = await makeWorld('8d');
  const u = await createUserWithToken(db(), w.tenantId, { email: `lead-${Date.now()}@8d.example`, displayName: 'Lena Lead', roles: [{ role: 'quality_manager', facility: w.facilities.A! }] });
  lead = (await loadActor(w.tenantId, u.userId))!;
  const m = await createUserWithToken(db(), w.tenantId, { email: `op-${Date.now()}@8d.example`, displayName: 'Oscar Operator', roles: [{ role: 'operator', facility: w.facilities.A! }] });
  member = (await loadActor(w.tenantId, m.userId))!;
});
afterAll(closePools);

describe('8D disciplines', () => {
  const base = {
    owner_user_id: 'o', champion_user_id: 'c', problem: 'Leaks at the bore seal', containment: 'Sorted 1,200 housings', containment_verification: '100% leak test since 10/02, none',
    root_cause_method: 'five_whys', root_cause: 'Worn boring bar', escape_point: 'Final leak test', escape_root_cause: 'Test pressure set below spec', root_cause_verification: 'Reproduced with the worn bar',
    prevention_note: null, status: 'actions', effective: null, recognition_note: null,
    is_is_not: { what: { is: 'HSG-200 bore seal leak' }, where: { is: 'VMC-2 only', isNot: 'VMC-1, same program' } },
  };

  it('says what each discipline still needs, in plain words', () => {
    const ds = disciplines({ ...base, champion_user_id: null, is_is_not: { what: { is: 'Leak' } } }, [{ user_id: 'o' }], [], [{ applies: null }]);
    const by = Object.fromEntries(ds.map((d) => [d.key, d]));
    expect(by.D1!.missing).toEqual(['name a champion (who can give the team time and resources)', 'add at least one team member besides the leader and champion']);
    expect(by.D2!.missing).toEqual(['say where it is seen', 'say at least one thing it is not (where or when it does not happen narrows the cause)']);
    expect(by.D3!.done).toBe(true);
    expect(by.D4!.done).toBe(true);
    expect(by.D5!.missing).toEqual(['add a corrective action for the root causes']);
    expect(by.D7!.missing).toEqual(['record the systemic changes (FMEA, control plan, procedures, training) or why none are needed', 'decide every read-across']);
    expect(by.D8!.done).toBe(false);
  });

  it('a done preventive action satisfies D7 without a note; cancelled actions never count', () => {
    const ds = disciplines(base, [{ user_id: 'm' }], [{ discipline: 'corrective', status: 'cancelled' }, { discipline: 'preventive', status: 'done' }], [{ applies: false }]);
    const by = Object.fromEntries(ds.map((d) => [d.key, d]));
    expect(by.D1!.done).toBe(true);
    expect(by.D5!.done).toBe(false);
    expect(by.D7!.done).toBe(true);
  });
});

describe('an 8D from opening to recognition', () => {
  let c: any;
  it('gates each step on its disciplines and lets the team read it', async () => {
    c = await asActor(w.qualityA, (tx) => createCapa(tx, w.qualityA, { facilityId: w.facilities.A!, title: 'Housing leaks at customer', problem: 'Customer returned 14 HSG-200 housings leaking at the bore seal',
      source: 'customer_complaint', ownerUserId: lead.userId, format: 'eight_d' }));
    expect(c.format).toBe('eight_d');
    await asActor(lead, (tx) => updateCapa(tx, lead, c.id, { containment: 'Quarantined 1,200 housings at the warehouse and the customer' }));
    await expect(asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).rejects.toThrow(/D1 Team: name a champion.* · D2 Problem description: say what the problem is.* · D3 Interim containment: say how you know/);
    await expect(asActor(lead, (tx) => updateCapa(tx, lead, c.id, { championUserId: lead.userId }))).rejects.toThrow(/someone other than the owner/);
    await asActor(lead, (tx) => updateCapa(tx, lead, c.id, {
      championUserId: w.opsA.userId, containmentVerification: '100% leak test at 6 bar since 10/02: 3 rejects in 1,200',
      isIsNot: { what: { is: 'Bore seal leak on HSG-200', isNot: 'Flange or port leaks' }, where: { is: 'Parts machined on VMC-2', isNot: 'VMC-1 parts, same program' }, when: { is: 'Since 09/20' } },
    }));
    await expect(asActor(lead, (tx) => addTeamMember(tx, lead, c.id, { userId: lead.userId }))).rejects.toThrow(/leads the 8D/);
    await asActor(lead, (tx) => addTeamMember(tx, lead, c.id, { userId: member.userId, expertise: 'VMC-2 operator' }));
    expect(await notices(member, 'quality.capa_team')).toEqual([`You are on the 8D team for ${c.number}: Housing leaks at customer`]);
    expect(await notices(w.opsA, 'quality.capa_team')).toEqual([`You are the champion for ${c.number}: Housing leaks at customer`]);
    // An operator has no quality.view, but a team member reads the 8D and finds it among theirs.
    expect((await asActor(member, (tx) => getCapa(tx, member, c.id))).team.map((t: any) => t.display_name)).toEqual(['Oscar Operator']);
    expect((await asActor(member, (tx) => listCapas(tx, member, { mine: true }))).map((x) => x.number)).toEqual([c.number]);
    expect(await asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).toBe('root_cause');
    // The format is fixed once past open.
    await expect(asActor(lead, (tx) => updateCapa(tx, lead, c.id, { format: 'standard' }))).rejects.toThrow(/only while the corrective action is open/);

    await asActor(lead, (tx) => updateCapa(tx, lead, c.id, { rootCauseMethod: 'five_whys', rootCause: 'Boring bar worn past its life; no tool-life count on VMC-2' }));
    await expect(asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).rejects.toThrow(/D4 Root causes: name where it should have been caught .*; state why it was not caught there .*; say how the causes were confirmed/);
    await asActor(lead, (tx) => updateCapa(tx, lead, c.id, { escapePoint: 'Final leak test', escapeRootCause: 'Leak tester set to 4 bar against a 6 bar specification',
      rootCauseVerification: 'Worn bar reproduced the leak on 5 of 5 parts; new bar 0 of 20' }));
    expect(await asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).toBe('actions');

    const fix = await asActor(lead, (tx) => addAction(tx, lead, { subjectType: 'corrective_action', subjectId: c.id, title: 'Tool-life counter on VMC-2 boring bar', ownerUserId: member.userId, dueDate: '2026-11-01', discipline: 'corrective' }));
    const ra = await asActor(lead, (tx) => addReadAcross(tx, lead, c.id, 'VMC-1 and VMC-3 boring operations'));
    await expect(asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).rejects.toThrow(/D7 Prevent recurrence: record the systemic changes .*; decide every read-across/);
    await expect(asActor(lead, (tx) => decideReadAcross(tx, lead, ra.id, { applies: true, note: 'ok' }))).rejects.toThrow(/say what was done there/);
    await asActor(lead, (tx) => decideReadAcross(tx, lead, ra.id, { applies: true, note: 'Same bar on VMC-3: counter added there too' }));
    await asActor(lead, (tx) => updateCapa(tx, lead, c.id, { preventionNote: 'PFMEA row 30 updated (tool wear, detection by counter); leak tester pressure in the control plan; setup sheet revised' }));
    await expect(asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).rejects.toThrow(/open actions/);
    await asActor(member, (tx) => completeAction(tx, member, fix.id, 'Counter set to 400 parts, alarm tested 10/22'));
    expect(await asActor(lead, (tx) => advanceCapa(tx, lead, c.id))).toBe('verification');
  });

  it('closes on the effectiveness check, then recognizes the team; the report prints every discipline', async () => {
    await expect(asActor(lead, (tx) => recognizeTeam(tx, lead, c.id, 'Great work from everyone'))).rejects.toThrow(/once the effectiveness check has closed/);
    await asActor(w.qualityA, (tx) => updateCapa(tx, w.qualityA, c.id, { verifyAfter: new Date().toISOString().slice(0, 10) }));
    await asActor(w.qualityA, (tx) => verifyCapa(tx, w.qualityA, c.id, { effective: true, note: '0 leaks in 2,400 housings over 4 weeks; customer confirmed' }));
    let got = await asActor(lead, (tx) => getCapa(tx, lead, c.id));
    expect(got.disciplines.filter((d: any) => !d.done).map((d: any) => d.key)).toEqual(['D8']);
    await asActor(lead, (tx) => recognizeTeam(tx, lead, c.id, 'Oscar found the wear pattern; thanks to the VMC-2 crew for the 100% test'));
    expect(await notices(member, 'quality.capa_team')).toContain(`${c.number} is closed: thank you`);
    got = await asActor(lead, (tx) => getCapa(tx, lead, c.id));
    expect(got.disciplines.every((d: any) => d.done)).toBe(true);
    const pdf = await renderEightDPdf(got);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it('a standard corrective action refuses 8D fields until switched while open', async () => {
    const s = await asActor(w.qualityA, (tx) => createCapa(tx, w.qualityA, { facilityId: w.facilities.A!, title: 'Label misprint', problem: 'Wrong revision on labels', source: 'internal', ownerUserId: lead.userId }));
    await expect(asActor(lead, (tx) => updateCapa(tx, lead, s.id, { escapePoint: 'Packing' }))).rejects.toThrow(/switch the format first/);
    await expect(asActor(lead, (tx) => addTeamMember(tx, lead, s.id, { userId: member.userId }))).rejects.toThrow(/not an 8D/);
    await asActor(lead, (tx) => updateCapa(tx, lead, s.id, { format: 'eight_d', escapePoint: 'Packing' }));
    expect((await asActor(lead, (tx) => getCapa(tx, lead, s.id))).disciplines).toHaveLength(8);
  });
});
