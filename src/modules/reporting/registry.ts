import { assetAvailabilityReport, maintenanceBacklogReport } from './definitions.js';
import { qualificationStatusReport, trainingComplianceReport } from './learning-reports.js';
import { mocRegisterReport } from './moc-reports.js';
import { inventoryReorderReport, pmComplianceReport } from './pm-reports.js';
import { purchasingStatusReport } from './purchasing-reports.js';
import { apAgingReport } from './ap-reports.js';
import { laborTimeReport } from './time-reports.js';
import { salesPipelineReport } from './sales-reports.js';
import { arAgingReport } from './ar-reports.js';
import { productionStatusReport } from './production-reports.js';
import { qualityStatusReport, safetySummaryReport } from './quality-reports.js';
import { kitReadinessReport } from './materials-reports.js';
import { fmeaRiskReport } from './fmea-reports.js';
import { continuityReadinessReport } from './continuity-reports.js';
import type { ReportDefinition } from './types.js';

export const REPORTS: ReportDefinition[] = [maintenanceBacklogReport, assetAvailabilityReport, qualificationStatusReport, trainingComplianceReport, mocRegisterReport, pmComplianceReport, inventoryReorderReport, purchasingStatusReport, apAgingReport, laborTimeReport, salesPipelineReport, arAgingReport, productionStatusReport, qualityStatusReport, safetySummaryReport, kitReadinessReport, fmeaRiskReport, continuityReadinessReport];
export const getReport = (id: string) => REPORTS.find((r) => r.id === id);
