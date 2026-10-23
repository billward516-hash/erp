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
import { openingBalancesTarget } from './opening-balances.js';
import { chartOfAccountsTarget, departmentsTarget, stockLocationsTarget, workCentersTarget } from './setup.js';
import { usersRolesTarget } from './users.js';
import { budgetLinesTarget, opportunitiesTarget, qualificationsTarget } from './commercial-setup.js';
import { earningCodesTarget, expenseCategoriesTarget, meterReadingsTarget, salesItemsTarget, timesheetHistoryTarget } from './misc-setup.js';
import { calibrationTarget, ncrHistoryTarget, safetyHistoryTarget, spcCharacteristicsTarget } from './quality-setup.js';
import { pmPlansTarget, routingsTarget } from './production-setup.js';
import { openCustomerInvoicesTarget, openPurchaseOrdersTarget, openSupplierBillsTarget } from './open-items.js';
import type { TargetDefinition } from './types.js';

/** Recommended load order for a migration: referenced records first. */
export const TARGETS: TargetDefinition[] = [sitesTarget, departmentsTarget, employeesTarget, usersRolesTarget, assetsTarget, partsTarget, stockLocationsTarget, stockBalancesTarget, assetPartsTarget, meterReadingsTarget, pmPlansTarget, bomsTarget, workCentersTarget, routingsTarget, suppliersTarget, supplierPricesTarget, openPurchaseOrdersTarget, supplierDeliveriesTarget, spendHistoryTarget, budgetLinesTarget, chartOfAccountsTarget, openingBalancesTarget, bankTransactionsTarget, customersTarget, salesItemsTarget, opportunitiesTarget, openCustomerInvoicesTarget, openSupplierBillsTarget, customerForecastsTarget, consumptionRatesTarget, rentalUnitsTarget, leasesTarget, maintenanceHistoryTarget, downtimeTarget, conditionPointsTarget, conditionReadingsTarget, spcCharacteristicsTarget, spcMeasurementsTarget, calibrationTarget, ncrHistoryTarget, safetyHistoryTarget, qualificationsTarget, qualificationRecordsTarget, earningCodesTarget, timesheetHistoryTarget, expenseCategoriesTarget];

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
