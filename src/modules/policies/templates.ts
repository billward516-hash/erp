/**
 * Policy templates (D-128): starting points, not legal advice. Each section marks what the company must decide or
 * describe with [[double brackets]]; a draft cannot be published while any remain. Employment law differs by state
 * and country; the company (and its counsel) owns the final text. `{{expense_rules}}` renders the live expense rules.
 */
export interface PolicyTemplate { key: string; title: string; category: 'handbook' | 'expense'; order?: number; requiresAcknowledgement: boolean; body: string }

export const TEMPLATE_NOTICE = 'Template text. Have it reviewed for your state or country before publishing; it is not legal advice.';

const H = (key: string, order: number, title: string, body: string): PolicyTemplate => ({ key: `handbook.${key}`, title, category: 'handbook', order, requiresAcknowledgement: true, body: body.trim() });

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  H('welcome', 10, 'Welcome and about us', `
## Welcome

Welcome to [[Company name]]. This handbook explains how we work together, what you can expect from us and what we expect from you.

## About us

[[Two or three sentences: what the company does, who its customers are, and how long it has operated.]]

## About this handbook

This handbook is a guide, not a contract of employment. [[Company name]] may change its policies; when it does, the new version is published here and you will be asked to read it. If a policy here conflicts with a written agreement or the law, the agreement or the law applies.

Questions go to [[name or role, e.g. HR Manager]].
`),
  H('employment', 20, 'Employment basics', `
## At-will employment

[[Confirm whether employment is at will in your state or country, and say so plainly; delete this section where it does not apply.]]

## Equal opportunity

[[Company name]] makes employment decisions without regard to race, color, religion, sex, sexual orientation, gender identity, national origin, age, disability, genetic information, veteran status or any other status protected by law.

## Employee classifications

- **Full-time:** scheduled [[number]] or more hours a week.
- **Part-time:** scheduled fewer than [[number]] hours a week.
- **Exempt and non-exempt:** non-exempt employees are paid overtime as the law requires.

## Introductory period

[[State whether there is an introductory period, how long, and what it means; or delete.]]
`),
  H('conduct', 30, 'Code of conduct', `
## How we treat each other

We expect honesty, respect and safe work from everyone. Raise concerns early; no one will be punished for a concern raised in good faith.

## Conflicts of interest

Tell [[role]] about any outside work, investment or relationship that could affect your decisions here.

## Gifts

Do not accept gifts from suppliers or customers worth more than [[amount]], or any cash.

## Reporting concerns

Report concerns to your supervisor, [[role]], or [[anonymous channel, if any]].
`),
  H('harassment', 40, 'Anti-harassment and anti-discrimination', `
## Our commitment

Harassment and discrimination are not tolerated, whether by employees, supervisors, customers, suppliers or visitors.

## What to do

If you experience or see harassment, report it to [[role]] or [[alternate role]]. You may skip anyone involved. Reports are investigated promptly and kept as confidential as the investigation allows.

## No retaliation

Retaliation against anyone who reports in good faith or takes part in an investigation is itself a violation of this policy.
`),
  H('hours', 50, 'Hours, timekeeping and pay', `
## Work hours

Normal hours are [[hours and shifts]]. Your supervisor sets your schedule.

## Recording time

Non-exempt employees record all time worked in the timesheet and submit it every week for approval. Working off the clock is not allowed.

## Overtime

Overtime must be approved in advance by your supervisor and is paid as the law requires.

## Paydays

Pay is [[weekly / every two weeks / twice a month]], on [[day]]. Report any pay error to [[role]] right away.
`),
  H('time-off', 60, 'Paid time off and holidays', `
## Paid time off

Full-time employees earn [[number of hours or days]] of paid time off a year, accrued [[each pay period / monthly]]. [[Carry-over and payout rules.]]

## Requesting time off

Ask your supervisor at least [[number]] days ahead, except for illness or emergencies.

## Holidays

The company observes: [[list of holidays]].

## Leave of absence

[[Describe family, medical, military and other leave as required in your state or country.]]
`),
  H('safety', 70, 'Safety', `
## Everyone's responsibility

Follow safe work procedures, wear the required protective equipment, and stop any job you believe is unsafe.

## Report every incident

Report injuries, near misses and unsafe conditions the same day in the safety section of this system, or to your supervisor.

## Qualified work only

Operate and maintain only the equipment you are qualified for. The system shows your current qualifications.

## Drugs and alcohol

Working under the influence of alcohol or drugs is prohibited. [[Testing policy, if any.]]
`),
  H('technology', 80, 'Technology, data and confidentiality', `
## Company systems

Company devices, email and systems are for business use. [[State what personal use is allowed.]] Activity on them may be monitored.

## Passwords and access

Keep your sign-in private and never share it. Report a lost device or a suspicious message to [[role]] at once.

## Confidential information

Customer, supplier, pricing, design and employee information stays confidential during and after your employment.
`),
  H('expenses', 90, 'Business expenses', `
## Summary

The company reimburses reasonable expenses incurred for business. Submit them as expense reports in this system; the full rules are in the Expense and travel policy. Approved expenses are repaid [[how and when, e.g. with the next payroll]].
`),
  H('conduct-discipline', 100, 'Performance and discipline', `
## Reviews

Performance is reviewed [[annually / twice a year]] with your supervisor.

## Corrective steps

Problems are usually addressed through coaching, a written warning, and a final warning, but [[Company name]] may skip steps for serious misconduct.
`),
  H('leaving', 110, 'Leaving the company', `
## Resignation

Please give at least [[number]] weeks' notice.

## Final pay and property

Final pay follows the law of [[state or country]]. Return all company property, keys and devices on your last day.
`),
  H('acknowledgement', 120, 'Acknowledgement', `
By acknowledging this handbook in the system, I confirm that I have read it, that I know where to find it, and that I will ask [[role]] about anything I do not understand. I understand the company may change these policies and will ask me to read changes.
`),
  {
    key: 'expense.travel', title: 'Expense and travel policy', category: 'expense', requiresAcknowledgement: true, body: `
## Purpose

This policy says which business expenses [[Company name]] reimburses, the limits that apply, and how to claim them.

## General rules

- Spend company money as carefully as your own; choose the reasonable option, not the most expensive.
- Expenses must be for company business and claimed in an expense report within the time limit below.
- Personal expenses, fines, and alcohol (except at an approved business meal) are not reimbursed.
- Keep itemized receipts. Where a receipt is lost, explain why in the report.

## Limits and receipts

These rules are checked by the system when you submit a report:

{{expense_rules}}

## Approvals

Reports are approved by the people the company sets for your site, department and the report amount, shown on the report before you submit. Nobody approves their own expenses.

## Travel

- Book [[economy airfare / the lowest logical fare]] at least [[number]] days ahead where possible.
- [[Rules for hotels, rental cars, and personal days added to a business trip.]]

## Reimbursement

Approved reports are paid [[with the next payroll / by direct deposit within N days]].

## Misuse

Claiming personal or false expenses is a serious violation and may lead to discipline and recovery of the amounts.
`.trim(),
  },
];

const PLACEHOLDER = /\[\[[^\]]*\]\]/g;
/** The placeholders still in a body ("[[Company name]]", ...), in order, unique. */
export function placeholders(body: string): string[] {
  return [...new Set(body.match(PLACEHOLDER) ?? [])];
}
