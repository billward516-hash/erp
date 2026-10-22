import { bomsTarget } from './boms.js';
import { assetPartsTarget } from './asset-parts.js';
import { customersTarget } from './customers.js';
import { supplierPricesTarget, suppliersTarget } from './suppliers.js';
import { assetsTarget } from './assets.js';
import { downtimeTarget } from './downtime.js';
import { employeesTarget } from './employees.js';
import { maintenanceHistoryTarget } from './maintenance-history.js';
import { partsTarget } from './parts.js';
import { qualificationRecordsTarget } from './qualifications.js';
import { stockBalancesTarget } from './stock.js';
import type { TargetDefinition } from './types.js';

/** Recommended load order for a migration: referenced records first. */
export const TARGETS: TargetDefinition[] = [employeesTarget, assetsTarget, partsTarget, stockBalancesTarget, assetPartsTarget, bomsTarget, suppliersTarget, supplierPricesTarget, customersTarget, maintenanceHistoryTarget, downtimeTarget, qualificationRecordsTarget];

export function getTarget(key: string): TargetDefinition | undefined {
  return TARGETS.find((t) => t.key === key);
}

/** Public description of a target (for building mapping UIs and documentation). */
export function describeTarget(t: TargetDefinition) {
  return {
    key: t.key, label: t.label, description: t.description, naturalKey: t.naturalKey, supportsCustomFields: t.supportsCustomFields,
    fields: t.fields.map(({ key, label, type, required, description, values, synonyms }) => ({ key, label, type, required: !!required, description, values, exampleHeaders: synonyms?.slice(0, 5) })),
  };
}
