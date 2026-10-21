import { requirePermission } from '../../../platform/auth/actor.js';
import { audit } from '../../../platform/audit/audit.js';
import { many, one } from '../../../platform/db/tx.js';
import { addMonths } from '../../learning/qualifications.js';
import type { TargetDefinition } from './types.js';

/**
 * Legacy qualification records (HR training matrices, certification spreadsheets). Imported grants are
 * marked origin='import' and need qualifications.grant to commit: the importer vouches that the source
 * records were authorized. Their supporting evidence stays in the source system, and reports say so.
 */
export const qualificationRecordsTarget: TargetDefinition = {
  key: 'qualification_records',
  label: 'Qualification records (legacy training matrix)',
  entityType: 'employee_qualification',
  description: 'One row per person and qualification, or a wide training matrix (one column per qualification) using the unpivot option. Qualifications must be defined first.',
  naturalKey: 'employee_number',
  commitPermission: 'qualifications.grant',
  supportsCustomFields: false,
  fields: [
    { key: 'employee_number', label: 'Employee number', type: 'string', required: true,
      synonyms: ['employee number', 'emp number', 'employee id', 'emp id', 'badge', 'badge number', 'clock number', 'id'] },
    { key: 'qualification_code', label: 'Qualification (code or name)', type: 'string', required: true,
      synonyms: ['qualification', 'qualification code', 'certification', 'cert', 'training', 'skill', 'competency', 'course'] },
    { key: 'effective_on', label: 'Completed / certified on', type: 'date',
      synonyms: ['completed', 'date completed', 'completion date', 'certified', 'certified on', 'trained on', 'issue date', 'issued', 'date'] },
    { key: 'expires_on', label: 'Expires', type: 'date', synonyms: ['expires', 'expiration', 'expiry', 'expiration date', 'recert due', 'renewal due', 'due'] },
    { key: 'note', label: 'Note', type: 'text', synonyms: ['note', 'notes', 'comment', 'comments', 'trainer', 'instructor'] },
  ],

  async validate(ctx, rows) {
    const emps = new Map((await many(ctx.tx, `SELECT id, lower(employee_number) AS n, facility_id, status FROM employee`)).map((e) => [e.n, e]));
    const quals = await many(ctx.tx, 'SELECT id, code, name, validity_months FROM qualification');
    const byKey = new Map(quals.flatMap((q) => [[q.code.toLowerCase(), q], [q.name.toLowerCase(), q]]));
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const emp = v.employee_number ? emps.get(String(v.employee_number).toLowerCase()) : undefined;
      if (v.employee_number && !emp) row.messages.push({ level: 'error', field: 'employee_number', message: `employee "${v.employee_number}" not found — import employees first` });
      const q = v.qualification_code ? byKey.get(String(v.qualification_code).trim().toLowerCase()) : undefined;
      if (v.qualification_code && !q) {
        row.messages.push({ level: 'error', field: 'qualification_code', message: `qualification "${v.qualification_code}" is not defined — define it, or map this header to a code with a valueMap` });
      }
      if (!emp || !q) continue;
      v._employee_id = emp.id;
      v._facility_id = emp.facility_id;
      v._qualification_id = q.id;
      const key = `${emp.id}:${q.id}`;
      if (seen.has(key)) row.messages.push({ level: 'error', message: `same person and qualification already on row ${seen.get(key)}` });
      else seen.set(key, row.rowNumber);
      if (!v.effective_on) {
        v.effective_on = today;
        row.messages.push({ level: 'warning', field: 'effective_on', message: 'no completion date on record; validity is counted from today' });
      }
      if (String(v.effective_on) > today) row.messages.push({ level: 'error', field: 'effective_on', message: 'completion date is in the future' });
      if (!v.expires_on && q.validity_months) v.expires_on = addMonths(String(v.effective_on), q.validity_months);
      if (v.expires_on && String(v.expires_on) < String(v.effective_on)) row.messages.push({ level: 'error', field: 'expires_on', message: 'expires before it was completed' });
      else if (v.expires_on && String(v.expires_on) < today) row.messages.push({ level: 'warning', field: 'expires_on', message: `already expired on ${v.expires_on}; imported as history` });
      const same = await one(ctx.tx, `SELECT 1 FROM employee_qualification WHERE employee_id = $1 AND qualification_id = $2 AND effective_on = $3`, [emp.id, q.id, v.effective_on]);
      row.action = same ? 'unchanged' : 'create';
    }
  },

  async commitRow(ctx, row) {
    const v = row.values;
    requirePermission(ctx.actor, 'qualifications.grant', v._facility_id as string);
    const same = await one(ctx.tx, `SELECT id FROM employee_qualification WHERE employee_id = $1 AND qualification_id = $2 AND effective_on = $3`,
      [v._employee_id, v._qualification_id, v.effective_on]);
    if (same) return { entityId: same.id, action: 'unchanged' };
    const g = await one(
      ctx.tx,
      `INSERT INTO employee_qualification (tenant_id, employee_id, qualification_id, granted_by, effective_on, expires_on, basis, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'import') RETURNING id`,
      [ctx.actor.tenantId, v._employee_id, v._qualification_id, ctx.actor.userId, v.effective_on, v.expires_on ?? null,
        { source: 'legacy import', sourceSystem: ctx.sourceSystem, batchId: ctx.batchId, sourceRow: row.rowNumber, sourceColumn: row.sourceColumn ?? null, note: v.note ?? null }],
    );
    await audit(ctx.tx, ctx.actor, { action: 'qualification.imported', entityType: 'employee', entityId: v._employee_id as string, facilityId: v._facility_id as string,
      data: { grantId: g.id, qualificationId: v._qualification_id, effectiveOn: v.effective_on, expiresOn: v.expires_on ?? null, batchId: ctx.batchId } });
    return { entityId: g.id, action: 'create' };
  },
};
