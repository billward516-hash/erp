import { ImprovementDetail, Improvements } from './pages/Improvements';
import { ShiftLog, ShiftLogDetail } from './pages/ShiftLog';
import { Outbox } from './pages/Outbox';
import { DocumentVersionRedirect, DocumentView, NewDocument, Repository, WorkInstructionEditor } from './pages/Documents';
import { SpcDetail } from './pages/Spc';
import { Policies, PolicyDetail } from './pages/Policies';
import { News, People, SearchResults } from './pages/Intranet';
import { ExpenseDetail, Expenses } from './pages/Expenses';
import { BudgetDetail, Budgets } from './pages/Budgets';
import { CompareProformas, NewProforma, ProformaDetail, Proformas } from './pages/Proforma';
import { Books } from './pages/Books';
import { Fragment, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Approvals } from './pages/Approvals';
import { AssetDetail, AssetByQr, Assets } from './pages/Assets';
import { ChangeDetail, Changes, NewChange } from './pages/Changes';
import { Home } from './pages/Home';
import { Imports } from './pages/Imports';
import { Inventory } from './pages/Inventory';
import { Scan } from './pages/Scan';
import { AgreementDetail, NewAgreement, NewCallout, Service, ServiceVisitDetail } from './pages/Service';
import { MyDay } from './pages/MyDay';
import { FitInterview } from './pages/FitInterview';
import { MySettings } from './pages/MySettings';
import { NewNotice, NoticeDetail } from './pages/Notices';
import { NewTempChange, TempChangeDetail } from './pages/TempChanges';
import { PmPlanDetail, PmSchedule } from './pages/Pm';
import { CaptureInvoice, InvoiceDetail, Payables } from './pages/Payables';
import { CreditMemoDetail, CustomerAccount, ReceivableDetail, Receivables } from './pages/Receivables';
import { Production, ProductionOrderDetail, RevisionDetail } from './pages/Production';
import { AuditDetail, CalibrationDetail, CapaDetail, NcrDetail, NewCapa, Quality } from './pages/Quality';
import { IncidentDetail, Safety } from './pages/Safety';
import { FmeaDetail } from './pages/Fmea';
import { Continuity, ContinuityDetail } from './pages/Continuity';
import { PublicRequest, Sites } from './pages/Sites';
import { LeaseDetail, Leasing } from './pages/Leasing';
import { Stores, VisitDetail } from './pages/Stores';
import { ForecastDetail, Planning } from './pages/Planning';
import { Integrations } from './pages/Integrations';
import { Time, TimesheetDetail } from './pages/Time';
import { Notifications } from './pages/Notifications';
import { Crm, CustomerDetail, NewCustomer } from './pages/Crm';
import { CustomerRfqDetail, NewCustomerRfq } from './pages/CustomerRfq';
import { NewQuote, OrderDetail, QuoteDetail, Sales } from './pages/Sales';
import { NewPurchaseRequest, PurchaseOrderDetail, PurchaseRequestDetail, Purchasing, SupplierDetail } from './pages/Purchasing';
import { Login } from './pages/Login';
import { SignedIn, SignInSettings } from './pages/SignIn';
import { LotDetail } from './pages/Lots';
import { Features } from './pages/Features';
import { Access } from './pages/Access';
import { Retention } from './pages/Retention';
import { ArchiveDetail, Archives } from './pages/Archives';
import { Jobs } from './pages/Jobs';
import { Implementation } from './pages/Implementation';
import { Late } from './pages/Late';
import { NewRfq, RfqDetail } from './pages/Rfq';
import { Reminders } from './pages/Reminders';
import { Reviews } from './pages/Reviews';
import { Performance, PerformanceDetail } from './pages/Performance';
import { Capa, NewCapaModule } from './pages/Capa';
import { ReportView, Reports } from './pages/Reports';
import { EnrollmentDetail, Training } from './pages/Training';
import { WorkOrderDetail, WorkOrders } from './pages/WorkOrders';
import { NewTicket, PublicTicket, TicketDetail, Tickets } from './pages/Tickets';

/** A detail page starts fresh when its record changes (a link to another record of the same kind keeps the component mounted otherwise). */
function ById({ children }: { children: ReactNode }) {
  const { id } = useParams();
  return <Fragment key={id}>{children}</Fragment>;
}

function Routed() {
  const { me, loading } = useAuth();
  // Request links work without signing in (residents, store staff).
  if (window.location.pathname.startsWith('/r/')) return <Routes><Route path="/r/:token" element={<PublicRequest />} /></Routes>;
  if (window.location.pathname.startsWith('/t/')) return <Routes><Route path="/t/:token" element={<PublicTicket />} /></Routes>;
  if (window.location.pathname === '/signed-in') return <SignedIn />;
  if (loading) return <div className="empty">Loading…</div>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="sign-in-settings" element={<SignInSettings />} />
        <Route path="features" element={<Features />} />
        <Route path="access" element={<Access />} />
        <Route path="retention" element={<Retention />} />
        <Route path="archives" element={<Archives />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="implementation" element={<Implementation />} />
        <Route path="late" element={<Late />} />
        <Route path="archives/:id" element={<ById><ArchiveDetail /></ById>} />
        <Route path="reminders" element={<Reminders />} />
        <Route path="reviews" element={<Reviews />} />
        <Route path="capa" element={<Capa />} />
        <Route path="capa/new" element={<NewCapaModule />} />
        <Route path="performance" element={<Performance />} />
        <Route path="performance/:id" element={<ById><PerformanceDetail /></ById>} />
        <Route path="assets" element={<Assets />} />
        <Route path="assets/:id" element={<ById><AssetDetail /></ById>} />
        <Route path="a/:token" element={<AssetByQr />} />
        <Route path="work-orders" element={<WorkOrders />} />
        <Route path="work-orders/:id" element={<ById><WorkOrderDetail /></ById>} />
        <Route path="pm" element={<PmSchedule />} />
        <Route path="pm/:id" element={<ById><PmPlanDetail /></ById>} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="scan" element={<Scan />} />
        <Route path="fit" element={<FitInterview />} />
        <Route path="my-settings" element={<MySettings />} />
        <Route path="service" element={<Service />} />
        <Route path="service/my-day" element={<MyDay />} />
        <Route path="service/callouts/new" element={<NewCallout />} />
        <Route path="service/agreements/new" element={<NewAgreement />} />
        <Route path="service/agreements/:id" element={<ById><AgreementDetail /></ById>} />
        <Route path="service/visits/:id" element={<ById><ServiceVisitDetail /></ById>} />
        <Route path="ap" element={<Payables />} />
        <Route path="production" element={<Production />} />
        <Route path="production/floor" element={<Production floor />} />
        <Route path="production/orders/:id" element={<ById><ProductionOrderDetail /></ById>} />
        <Route path="production/revisions/:id" element={<ById><RevisionDetail /></ById>} />
        <Route path="quality" element={<Quality />} />
        <Route path="quality/ncr/:id" element={<ById><NcrDetail /></ById>} />
        <Route path="quality/capa/new" element={<NewCapa />} />
        <Route path="quality/capa/:id" element={<ById><CapaDetail /></ById>} />
        <Route path="quality/calibration/:id" element={<ById><CalibrationDetail /></ById>} />
        <Route path="quality/audits/:id" element={<ById><AuditDetail /></ById>} />
        <Route path="quality/fmea/:id" element={<ById><FmeaDetail /></ById>} />
        <Route path="quality/spc/:id" element={<ById><SpcDetail /></ById>} />
        <Route path="documents" element={<Repository />} />
        <Route path="documents/new" element={<NewDocument />} />
        <Route path="documents/version/:id" element={<ById><DocumentVersionRedirect /></ById>} />
        <Route path="documents/:id/instruction" element={<ById><WorkInstructionEditor /></ById>} />
        <Route path="documents/:id" element={<ById><DocumentView /></ById>} />
        <Route path="outbox" element={<Outbox />} />
        <Route path="policies" element={<Policies />} />
        <Route path="news" element={<News />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="budgets" element={<Budgets />} />
        <Route path="proforma" element={<Proformas />} />
        <Route path="proforma/new" element={<NewProforma />} />
        <Route path="proforma/compare" element={<CompareProformas />} />
        <Route path="proforma/:id" element={<ById><ProformaDetail /></ById>} />
        <Route path="books" element={<Books />} />
        <Route path="budgets/:id" element={<ById><BudgetDetail /></ById>} />
        <Route path="expenses/:id" element={<ById><ExpenseDetail /></ById>} />
        <Route path="people" element={<People />} />
        <Route path="search" element={<SearchResults />} />
        <Route path="policies/:id" element={<ById><PolicyDetail /></ById>} />
        <Route path="shift-log" element={<ShiftLog />} />
        <Route path="shift-log/:id" element={<ById><ShiftLogDetail /></ById>} />
        <Route path="improvements" element={<Improvements />} />
        <Route path="improvements/:id" element={<ById><ImprovementDetail /></ById>} />
        <Route path="safety" element={<Safety />} />
        <Route path="safety/:id" element={<ById><IncidentDetail /></ById>} />
        <Route path="sites" element={<Sites />} />
        <Route path="leasing" element={<Leasing />} />
        <Route path="stores" element={<Stores />} />
        <Route path="planning" element={<Planning />} />
        <Route path="planning/forecasts/:id" element={<ById><ForecastDetail /></ById>} />
        <Route path="stores/visits/:id" element={<ById><VisitDetail /></ById>} />
        <Route path="leasing/leases/:id" element={<ById><LeaseDetail /></ById>} />
        <Route path="continuity" element={<Continuity />} />
        <Route path="continuity/:id" element={<ById><ContinuityDetail /></ById>} />
        <Route path="receivables" element={<Receivables />} />
        <Route path="receivables/customers/:id" element={<ById><CustomerAccount /></ById>} />
        <Route path="receivables/credits/:id" element={<ById><CreditMemoDetail /></ById>} />
        <Route path="inventory/lots/:id" element={<ById><LotDetail /></ById>} />
        <Route path="receivables/:id" element={<ById><ReceivableDetail /></ById>} />
        <Route path="ap/new" element={<CaptureInvoice />} />
        <Route path="ap/:id" element={<ById><InvoiceDetail /></ById>} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="crm" element={<Crm />} />
        <Route path="crm/customers/new" element={<NewCustomer />} />
        <Route path="crm/customers/:id" element={<ById><CustomerDetail /></ById>} />
        <Route path="sales" element={<Sales />} />
        <Route path="sales/rfq/new" element={<NewCustomerRfq />} />
        <Route path="sales/rfq/:id" element={<ById><CustomerRfqDetail /></ById>} />
        <Route path="sales/quotes/new" element={<NewQuote />} />
        <Route path="sales/quotes/:id" element={<ById><QuoteDetail /></ById>} />
        <Route path="sales/orders/:id" element={<ById><OrderDetail /></ById>} />
        <Route path="time" element={<Time />} />
        <Route path="time/:id" element={<ById><TimesheetDetail /></ById>} />
        <Route path="purchasing" element={<Purchasing />} />
        <Route path="purchasing/rfq/new" element={<NewRfq />} />
        <Route path="purchasing/rfq/:id" element={<ById><RfqDetail /></ById>} />
        <Route path="purchasing/requests/new" element={<NewPurchaseRequest />} />
        <Route path="purchasing/requests/:id" element={<ById><PurchaseRequestDetail /></ById>} />
        <Route path="purchasing/orders/:id" element={<ById><PurchaseOrderDetail /></ById>} />
        <Route path="purchasing/suppliers/:id" element={<ById><SupplierDetail /></ById>} />
        <Route path="changes" element={<Changes />} />
        <Route path="changes/new" element={<NewChange />} />
        <Route path="changes/notices/new" element={<NewNotice />} />
        <Route path="changes/temporary/new" element={<NewTempChange />} />
        <Route path="changes/temporary/:id" element={<ById><TempChangeDetail /></ById>} />
        <Route path="changes/notices/:id" element={<ById><NoticeDetail /></ById>} />
        <Route path="changes/:id" element={<ById><ChangeDetail /></ById>} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="training" element={<Training />} />
        <Route path="training/enrollments/:id" element={<ById><EnrollmentDetail /></ById>} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/:id" element={<ById><ReportView /></ById>} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="tickets/new" element={<NewTicket />} />
        <Route path="tickets/:id" element={<ById><TicketDetail /></ById>} />
        <Route path="imports" element={<Imports />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return <AuthProvider><BrowserRouter><Routed /></BrowserRouter></AuthProvider>;
}
