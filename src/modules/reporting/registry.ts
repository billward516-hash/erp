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
import { kitReadinessReport, lotStatusReport } from './materials-reports.js';
import { fmeaRiskReport } from './fmea-reports.js';
import { continuityReadinessReport } from './continuity-reports.js';
import { reliabilityReport } from './reliability-reports.js';
import { serviceLevelReport } from './sites-reports.js';
import { rentRollReport } from './leasing-reports.js';
import { storeStandardsReport } from './storeops-reports.js';
import { capacityPlanReport } from './planning-reports.js';
import { spcSummaryReport } from './spc-reports.js';
import { supplierPerformanceReport } from './supplier-reports.js';
import { improvementReport } from './improvement-reports.js';
import { expenseSummaryReport } from './expense-reports.js';
import { budgetVsActualReport } from './budget-reports.js';
import { balanceSheetReport, cashFlowReport, profitAndLossReport } from './books-reports.js';
import { repairOrReplaceReport } from './lifecycle-reports.js';
import { proformaPortfolioReport } from './proforma-reports.js';
import { laborProductivityReport } from './labor-reports.js';
import { documentMasterListReport } from './document-reports.js';
import { specReviewReport } from './spec-review-reports.js';
import { documentReadsReport } from './document-read-reports.js';
import { servicePerformanceReport, serviceContractsReport } from './service-reports.js';
import { paymentBehaviorReport, poAgingReport, quoteAgingReport, rfqResponseReport, quoteOutcomesReport } from './timing-reports.js';
import { labOosReport, labTurnaroundReport, labWorkloadReport } from './lab-reports.js';
import { cleanroomMonitoringReport } from './cleanroom-reports.js';
import { chemicalReports } from './chemical-reports.js';
import { equipmentLogbookReport, equipmentQualificationReport, toolStatesReport } from './qualification-reports.js';
import type { ReportDefinition } from './types.js';

export const REPORTS: ReportDefinition[] = [servicePerformanceReport, serviceContractsReport, paymentBehaviorReport, poAgingReport, quoteAgingReport, rfqResponseReport, quoteOutcomesReport, maintenanceBacklogReport, assetAvailabilityReport, qualificationStatusReport, trainingComplianceReport, mocRegisterReport, pmComplianceReport, inventoryReorderReport, purchasingStatusReport, apAgingReport, laborTimeReport, salesPipelineReport, arAgingReport, productionStatusReport, qualityStatusReport, safetySummaryReport, kitReadinessReport, lotStatusReport, fmeaRiskReport, continuityReadinessReport, reliabilityReport, serviceLevelReport, rentRollReport, storeStandardsReport, capacityPlanReport, spcSummaryReport, supplierPerformanceReport, improvementReport, repairOrReplaceReport, expenseSummaryReport, budgetVsActualReport, profitAndLossReport, balanceSheetReport, proformaPortfolioReport, laborProductivityReport, documentMasterListReport, specReviewReport, documentReadsReport];
REPORTS.push(labTurnaroundReport, labOosReport, labWorkloadReport);
REPORTS.push(cashFlowReport);
REPORTS.push(...chemicalReports);
REPORTS.push(toolStatesReport, equipmentLogbookReport, equipmentQualificationReport);
import { benchOverbookingReport, staffingForecastReport, utilizationReport } from './staffing-reports.js';

import { ticketReports } from './ticket-reports.js';

REPORTS.push(...ticketReports);
import { billingRunsReport, billingWipReport, recurringRevenueReport } from './billing-reports.js';

import { projectStatusReport, projectTimeReport } from './project-reports.js';

REPORTS.push(projectStatusReport, projectTimeReport);
export const getReport = (id: string) => REPORTS.find((r) => r.id === id);
REPORTS.push(cleanroomMonitoringReport);
REPORTS.push(utilizationReport, benchOverbookingReport, staffingForecastReport);
REPORTS.push(billingWipReport, billingRunsReport, recurringRevenueReport);
REPORTS.push(projectStatusReport, projectTimeReport);
