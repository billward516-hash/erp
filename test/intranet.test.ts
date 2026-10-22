import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asActor } from '../src/platform/auth/actor.js';
import { closePools, getAdminPool } from '../src/platform/db/pool.js';
import { directory, listAnnouncements, postAnnouncement, saveQuickLink, search, upcoming, withdrawAnnouncement } from '../src/modules/intranet/service.js';
import type { World } from './fixtures.js';
import { makeWorld } from './fixtures.js';

const db = () => getAdminPool();
let w: World;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await makeWorld('intra');
  await db().query(`INSERT INTO employee (tenant_id, facility_id, employee_number, first_name, last_name, job_title, email, work_phone, office_location)
    VALUES ($1, $2, 'B-77', 'Bianca', 'Ortiz', 'Shipping lead', 'bianca@b.example', '555-0177', 'Dock office')`, [w.tenantId, w.facilities.B]);
});
afterAll(closePools);

describe('announcements', () => {
  it('reach the sites they are for; only posters post; safety notices also ring the bell', async () => {
    await expect(asActor(w.techA, (tx) => postAnnouncement(tx, w.techA, { title: 'Hello all', body: 'Hi' }))).rejects.toThrow(/announcements.post/);
    await asActor(w.admin, (tx) => postAnnouncement(tx, w.admin, { title: 'Open enrollment starts Monday', body: 'Benefits choices are due by the **15th**.', pinned: true }));
    await asActor(w.admin, (tx) => postAnnouncement(tx, w.admin, { title: 'Plant B parking lot repaving', body: 'Use lot 2 this week.', facilityId: w.facilities.B! }));
    await asActor(w.admin, (tx) => postAnnouncement(tx, w.admin, { title: 'Forklift recall check', body: 'Check serials against the list.', kind: 'safety' }));
    await expect(asActor(w.admin, (tx) => postAnnouncement(tx, w.admin, { title: 'Summer picnic', body: 'Food and games', kind: 'event' }))).rejects.toThrow(/needs its date/);
    await asActor(w.admin, (tx) => postAnnouncement(tx, w.admin, { title: 'Summer picnic', body: 'Food and games', kind: 'event', eventOn: inDays(10) }));
    const a = (await asActor(w.techA, (tx) => listAnnouncements(tx, w.techA))).map((x) => x.title);
    expect(a[0]).toBe('Open enrollment starts Monday'); // pinned first
    expect(a).not.toContain('Plant B parking lot repaving');
    expect((await asActor(w.operatorB, (tx) => listAnnouncements(tx, w.operatorB))).map((x) => x.title)).toContain('Plant B parking lot repaving');
    expect((await db().query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'announcement'`, [w.techA.userId])).rows[0].n).toBe(1);
    expect((await asActor(w.techA, (tx) => upcoming(tx, w.techA))).map((x) => x.title)).toEqual(['Summer picnic']);
  });

  it('withdrawn announcements leave the home page', async () => {
    const x = await asActor(w.admin, (tx) => postAnnouncement(tx, w.admin, { title: 'Wrong date posted', body: 'Oops' }));
    await asActor(w.admin, (tx) => withdrawAnnouncement(tx, w.admin, x.id));
    expect((await asActor(w.techA, (tx) => listAnnouncements(tx, w.techA))).map((a) => a.title)).not.toContain('Wrong date posted');
    expect((await asActor(w.admin, (tx) => listAnnouncements(tx, w.admin, { all: true }))).find((a) => a.title === 'Wrong date posted')?.withdrawn_at).toBeTruthy();
  });

  it('quick links must be https or a page here', async () => {
    await expect(asActor(w.admin, (tx) => saveQuickLink(tx, w.admin, { title: 'Payroll', url: 'http://payroll.example' }))).rejects.toThrow(/https/);
    await expect(asActor(w.admin, (tx) => saveQuickLink(tx, w.admin, { title: 'Bad', url: 'javascript:alert(1)' }))).rejects.toThrow(/https/);
    await asActor(w.admin, (tx) => saveQuickLink(tx, w.admin, { title: 'Benefits portal', url: 'https://benefits.example.com' }));
  });
});

describe('directory and search', () => {
  it('finds colleagues at other sites, with work contact details only', async () => {
    const found = await asActor(w.techA, (tx) => directory(tx, { search: 'shipping' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'Bianca Ortiz', site_code: 'B', work_phone: '555-0177', office_location: 'Dock office' });
    expect(Object.keys(found[0]).sort()).toEqual(['department', 'email', 'employee_id', 'job_title', 'name', 'office_location', 'person_key', 'site_code', 'site_name', 'user_id', 'work_phone']);
    // The employee row itself stays hidden from someone at another site.
    expect((await asActor(w.techA, (tx) => tx.query(`SELECT 1 FROM employee WHERE employee_number = 'B-77'`))).rowCount).toBe(0);
  });

  it('search covers people, policies and announcements, and records only where the user may see them', async () => {
    const r = await asActor(w.techA, (tx) => search(tx, w.techA, 'bianca'));
    expect(r.groups.map((g) => g.kind)).toEqual(['people']);
    const n = await asActor(w.techA, (tx) => search(tx, w.techA, 'enrollment'));
    expect(n.groups.map((g) => [g.kind, g.items.length])).toEqual([['news', 1]]);
    await db().query(`INSERT INTO customer (tenant_id, code, name) VALUES ($1, 'ENRL', 'Enrollment Labs')`, [w.tenantId]);
    expect((await asActor(w.techA, (tx) => search(tx, w.techA, 'enrollment'))).groups.map((g) => g.kind)).not.toContain('customers'); // no crm.view
    expect((await asActor(w.admin, (tx) => search(tx, w.admin, 'enrollment'))).groups.map((g) => g.kind)).toContain('customers');
    expect((await asActor(w.techA, (tx) => search(tx, w.techA, 'x'))).groups).toEqual([]);
  });
});
