import { assetAvailabilityReport, maintenanceBacklogReport } from './definitions.js';
import { qualificationStatusReport, trainingComplianceReport } from './learning-reports.js';
import type { ReportDefinition } from './types.js';

export const REPORTS: ReportDefinition[] = [maintenanceBacklogReport, assetAvailabilityReport, qualificationStatusReport, trainingComplianceReport];
export const getReport = (id: string) => REPORTS.find((r) => r.id === id);
