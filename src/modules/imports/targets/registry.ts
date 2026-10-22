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
import { sitesTarget } from './sites.js';
import { leasesTarget, rentalUnitsTarget } from './leasing.js';
import { conditionPointsTarget, conditionReadingsTarget } from './conditions.js';
import { customerForecastsTarget } from './forecasts.js';
import { spcMeasurementsTarget } from './spc.js';
import { consumptionRatesTarget } from './consumption.js';
import { supplierDeliveriesTarget } from './supplier-deliveries.js';
import { spendHistoryTarget } from './spend-history.js';
import { bankTransactionsTarget } from './bank-transactions.js';
import type { TargetDefinition } from './types.js';

/** Recommended load order for a migration: referenced records first. */
export const TARGETS: TargetDefinition[] = [sitesTarget, employeesTarget, assetsTarget, partsTarget, stockBalancesTarget, assetPartsTarget, bomsTarget, suppliersTarget, supplierPricesTarget, supplierDeliveriesTarget, spendHistoryTarget, bankTransactionsTarget, customersTarget, customerForecastsTarget, consumptionRatesTarget, rentalUnitsTarget, leasesTarget, maintenanceHistoryTarget, downtimeTarget, conditionPointsTarget, conditionReadingsTarget, spcMeasurementsTarget, qualificationRecordsTarget];

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
