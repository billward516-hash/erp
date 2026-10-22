/**
 * Starter chart of accounts for a small business (D-136). Each platform account key posts to exactly one account, so
 * invoices, bills, expenses and stock post without per-company setup; the company renames, adds and deactivates
 * accounts as it likes. System accounts (receivables, payables, retained earnings) cannot be deactivated.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface ChartAccount { code: string; name: string; type: AccountType; subtype: string; key?: string; system?: boolean }

export const DEFAULT_CHART: ChartAccount[] = [
  { code: '1000', name: 'Checking', type: 'asset', subtype: 'bank' },
  { code: '1050', name: 'Savings', type: 'asset', subtype: 'bank' },
  { code: '1100', name: 'Accounts receivable', type: 'asset', subtype: 'accounts_receivable', key: 'accounts_receivable', system: true },
  { code: '1200', name: 'Inventory', type: 'asset', subtype: 'inventory', key: 'inventory' },
  { code: '1300', name: 'Prepaid expenses', type: 'asset', subtype: 'current_asset' },
  { code: '1500', name: 'Equipment', type: 'asset', subtype: 'fixed_asset', key: 'capital_projects' },
  { code: '1550', name: 'Accumulated depreciation', type: 'asset', subtype: 'fixed_asset' },
  { code: '2000', name: 'Accounts payable', type: 'liability', subtype: 'accounts_payable', key: 'accounts_payable', system: true },
  { code: '2100', name: 'Credit card', type: 'liability', subtype: 'credit_card' },
  { code: '2150', name: 'Employee reimbursements payable', type: 'liability', subtype: 'current_liability', key: 'employee_reimbursement' },
  { code: '2200', name: 'Sales tax payable', type: 'liability', subtype: 'current_liability', key: 'sales_tax_payable' },
  { code: '2300', name: 'Payroll liabilities', type: 'liability', subtype: 'current_liability' },
  { code: '2500', name: 'Loans payable', type: 'liability', subtype: 'long_term_liability' },
  { code: '3000', name: 'Owner\'s equity', type: 'equity', subtype: 'equity', key: 'opening_balance' },
  { code: '3100', name: 'Owner\'s draws', type: 'equity', subtype: 'equity' },
  { code: '3900', name: 'Retained earnings', type: 'equity', subtype: 'retained_earnings', system: true },
  { code: '4000', name: 'Sales', type: 'income', subtype: 'income', key: 'sales_revenue' },
  { code: '4100', name: 'Service income', type: 'income', subtype: 'income', key: 'service_revenue' },
  { code: '4200', name: 'Rental income', type: 'income', subtype: 'income', key: 'rental_income' },
  { code: '4250', name: 'Tenant charges', type: 'income', subtype: 'income', key: 'tenant_charges' },
  { code: '4900', name: 'Freight income', type: 'income', subtype: 'income', key: 'freight_income' },
  { code: '4950', name: 'Other income', type: 'income', subtype: 'other_income' },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', subtype: 'cost_of_goods' },
  { code: '5100', name: 'Materials used', type: 'expense', subtype: 'cost_of_goods', key: 'production_materials' },
  { code: '5200', name: 'Freight in', type: 'expense', subtype: 'cost_of_goods', key: 'freight' },
  { code: '6000', name: 'Advertising', type: 'expense', subtype: 'expense' },
  { code: '6100', name: 'Bank fees', type: 'expense', subtype: 'expense' },
  { code: '6150', name: 'Insurance', type: 'expense', subtype: 'expense' },
  { code: '6200', name: 'Repairs and maintenance', type: 'expense', subtype: 'expense', key: 'maintenance_expense' },
  { code: '6250', name: 'Rent', type: 'expense', subtype: 'expense' },
  { code: '6300', name: 'Supplies', type: 'expense', subtype: 'expense', key: 'supplies_expense' },
  { code: '6350', name: 'Software and subscriptions', type: 'expense', subtype: 'expense' },
  { code: '6400', name: 'Contract and professional services', type: 'expense', subtype: 'expense', key: 'contract_services' },
  { code: '6450', name: 'Payroll expenses', type: 'expense', subtype: 'expense' },
  { code: '6500', name: 'Travel', type: 'expense', subtype: 'expense', key: 'travel_expense' },
  { code: '6510', name: 'Meals and entertainment', type: 'expense', subtype: 'expense', key: 'meals_entertainment' },
  { code: '6520', name: 'Training', type: 'expense', subtype: 'expense', key: 'training_expense' },
  { code: '6530', name: 'Phone and internet', type: 'expense', subtype: 'expense', key: 'telecom_expense' },
  { code: '6600', name: 'Utilities', type: 'expense', subtype: 'expense', key: 'utilities_expense' },
  { code: '6700', name: 'Taxes and licenses', type: 'expense', subtype: 'expense' },
  { code: '6800', name: 'Depreciation', type: 'expense', subtype: 'expense' },
  { code: '6900', name: 'Other expenses', type: 'expense', subtype: 'other_expense', key: 'other_expense' },
  { code: '6950', name: 'Sales tax paid', type: 'expense', subtype: 'expense', key: 'sales_tax' },
];

/** Debit-normal accounts (assets, expenses) grow with debits; the others with credits. */
export const debitNormal = (type: AccountType) => type === 'asset' || type === 'expense';
