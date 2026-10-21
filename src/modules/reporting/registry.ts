import { assetAvailabilityReport, maintenanceBacklogReport } from './definitions.js';
import { qualificationStatusReport, trainingComplianceReport } from './learning-reports.js';
import { mocRegisterReport } from './moc-reports.js';
import { inventoryReorderReport, pmComplianceReport } from './pm-reports.js';
import { purchasingStatusReport } from './purchasing-reports.js';
import { apAgingReport } from './ap-reports.js';
import type { ReportDefinition } from './types.js';

export const REPORTS: ReportDefinition[] = [maintenanceBacklogReport, assetAvailabilityReport, qualificationStatusReport, trainingComplianceReport, mocRegisterReport, pmComplianceReport, inventoryReorderReport, purchasingStatusReport, apAgingReport];
export const getReport = (id: string) => REPORTS.find((r) => r.id === id);
