import { z } from 'zod';

/**
 * MOC screening: a fixed questionnaire whose answers decide risk level, which disciplines must review,
 * whether a pre-startup safety review (PSSR) is required, and which implementation actions are created.
 * Deterministic and versioned (SCREENING_RULES) so every MOC records which rules judged it.
 * This supports a customer's MOC procedure; it does not decide regulatory applicability (e.g. OSHA PSM).
 */
export const SCREENING_RULES = 'moc-screening/1';

export const ScreeningSchema = z.object({
  affects_safety_systems: z.boolean().describe('Changes guarding, interlocks, E-stops, relief devices, fire or gas detection'),
  new_or_changed_chemical: z.boolean().describe('Introduces a chemical, gas or material not already approved for this use'),
  changes_operating_limits: z.boolean().describe('Changes speeds, pressures, temperatures, loads or other limits beyond current documented values'),
  affects_controls_software: z.boolean().describe('Changes PLC/CNC logic, parameters, alarms or SCADA'),
  affects_product_quality: z.boolean().describe('Could affect product conformity, customer requirements or approved processes (PPAP, FAI)'),
  affects_environmental: z.boolean().describe('Affects emissions, waste, discharges or a permit'),
  requires_procedure_change: z.boolean().describe('Operating, maintenance or emergency procedures must be written or revised'),
  requires_training: z.boolean().describe('People need training or new qualifications before working with the change'),
  affects_staffing: z.boolean().describe('Changes who does the work, staffing levels or responsibilities'),
});
export type Screening = z.infer<typeof ScreeningSchema>;

export const SCREENING_QUESTIONS = Object.entries(ScreeningSchema.shape).map(([key, s]) => ({ key, question: s.description }));

export interface ScreeningResult {
  riskLevel: 'low' | 'medium' | 'high';
  /** Role keys, in addition to final authorization by operations_manager. */
  reviews: string[];
  pssrRequired: boolean;
  reasons: string[];
}

export function screen(changeType: string, s: Screening, isTemporary: boolean): ScreeningResult {
  const reasons: string[] = [];
  const reviews = new Set<string>();
  let risk = 'low' as ScreeningResult['riskLevel'];
  const raise = (to: ScreeningResult['riskLevel'], why: string) => {
    if (to === 'high' || (to === 'medium' && risk === 'low')) risk = to;
    reasons.push(why);
  };
  if (s.affects_safety_systems) { raise('high', 'safety systems affected'); reviews.add('ehs_reviewer'); }
  if (s.new_or_changed_chemical) { raise('high', 'new or changed chemical/material'); reviews.add('ehs_reviewer'); }
  if (s.changes_operating_limits) { raise('high', 'operating limits change'); reviews.add('ehs_reviewer'); reviews.add('maintenance_manager'); }
  if (s.affects_environmental) { raise('medium', 'environmental impact'); reviews.add('ehs_reviewer'); }
  if (s.affects_controls_software) { raise('medium', 'controls/software change'); reviews.add('maintenance_manager'); }
  if (s.affects_product_quality) { raise('medium', 'product quality or customer requirements affected'); reviews.add('quality_reviewer'); }
  if (s.affects_staffing) { raise('medium', 'staffing or responsibilities change'); reviews.add('ehs_reviewer'); }
  if (['equipment', 'controls_software', 'facility'].includes(changeType)) reviews.add('maintenance_manager');
  if (s.requires_procedure_change || s.requires_training) raise('medium', 'procedures or training must change before use');
  if (isTemporary && risk === 'low') raise('medium', 'temporary change (needs a removal plan)');
  return { riskLevel: risk, reviews: [...reviews].sort(), pssrRequired: risk === 'high' || s.affects_safety_systems || s.new_or_changed_chemical, reasons };
}

/** Standard pre-startup safety review questions (customers can extend later). */
export const PSSR_QUESTIONS = [
  'Construction / installation matches the approved design and change description.',
  'Safety, operating, maintenance and emergency procedures are in place, approved and adequate.',
  'Hazard review recommendations are resolved, or tracked with an owner and date.',
  'Affected employees are trained, and any required qualifications are current.',
  'Equipment has been inspected and tested (guards, interlocks and instruments function).',
  'Drawings, asset records and spare parts information are updated.',
  'For temporary changes: removal date, owner and restoration steps are defined.',
];
