import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Approvals } from './pages/Approvals';
import { AssetDetail, AssetByQr, Assets } from './pages/Assets';
import { ChangeDetail, Changes, NewChange } from './pages/Changes';
import { Home } from './pages/Home';
import { Imports } from './pages/Imports';
import { Inventory } from './pages/Inventory';
import { PmPlanDetail, PmSchedule } from './pages/Pm';
import { CaptureInvoice, InvoiceDetail, Payables } from './pages/Payables';
import { CustomerAccount, ReceivableDetail, Receivables } from './pages/Receivables';
import { Production, ProductionOrderDetail, RevisionDetail } from './pages/Production';
import { AuditDetail, CalibrationDetail, CapaDetail, NcrDetail, NewCapa, Quality } from './pages/Quality';
import { IncidentDetail, Safety } from './pages/Safety';
import { FmeaDetail } from './pages/Fmea';
import { Continuity, ContinuityDetail } from './pages/Continuity';
import { Integrations } from './pages/Integrations';
import { Time, TimesheetDetail } from './pages/Time';
import { Notifications } from './pages/Notifications';
import { Crm, CustomerDetail, NewCustomer } from './pages/Crm';
import { NewQuote, OrderDetail, QuoteDetail, Sales } from './pages/Sales';
import { NewPurchaseRequest, PurchaseOrderDetail, PurchaseRequestDetail, Purchasing, SupplierDetail } from './pages/Purchasing';
import { Login } from './pages/Login';
import { ReportView, Reports } from './pages/Reports';
import { EnrollmentDetail, Training } from './pages/Training';
import { WorkOrderDetail, WorkOrders } from './pages/WorkOrders';

function Routed() {
  const { me, loading } = useAuth();
  if (loading) return <div className="empty">Loading…</div>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="assets" element={<Assets />} />
        <Route path="assets/:id" element={<AssetDetail />} />
        <Route path="a/:token" element={<AssetByQr />} />
        <Route path="work-orders" element={<WorkOrders />} />
        <Route path="work-orders/:id" element={<WorkOrderDetail />} />
        <Route path="pm" element={<PmSchedule />} />
        <Route path="pm/:id" element={<PmPlanDetail />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="ap" element={<Payables />} />
        <Route path="production" element={<Production />} />
        <Route path="production/floor" element={<Production floor />} />
        <Route path="production/orders/:id" element={<ProductionOrderDetail />} />
        <Route path="production/revisions/:id" element={<RevisionDetail />} />
        <Route path="quality" element={<Quality />} />
        <Route path="quality/ncr/:id" element={<NcrDetail />} />
        <Route path="quality/capa/new" element={<NewCapa />} />
        <Route path="quality/capa/:id" element={<CapaDetail />} />
        <Route path="quality/calibration/:id" element={<CalibrationDetail />} />
        <Route path="quality/audits/:id" element={<AuditDetail />} />
        <Route path="quality/fmea/:id" element={<FmeaDetail />} />
        <Route path="safety" element={<Safety />} />
        <Route path="safety/:id" element={<IncidentDetail />} />
        <Route path="continuity" element={<Continuity />} />
        <Route path="continuity/:id" element={<ContinuityDetail />} />
        <Route path="receivables" element={<Receivables />} />
        <Route path="receivables/customers/:id" element={<CustomerAccount />} />
        <Route path="receivables/:id" element={<ReceivableDetail />} />
        <Route path="ap/new" element={<CaptureInvoice />} />
        <Route path="ap/:id" element={<InvoiceDetail />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="crm" element={<Crm />} />
        <Route path="crm/customers/new" element={<NewCustomer />} />
        <Route path="crm/customers/:id" element={<CustomerDetail />} />
        <Route path="sales" element={<Sales />} />
        <Route path="sales/quotes/new" element={<NewQuote />} />
        <Route path="sales/quotes/:id" element={<QuoteDetail />} />
        <Route path="sales/orders/:id" element={<OrderDetail />} />
        <Route path="time" element={<Time />} />
        <Route path="time/:id" element={<TimesheetDetail />} />
        <Route path="purchasing" element={<Purchasing />} />
        <Route path="purchasing/requests/new" element={<NewPurchaseRequest />} />
        <Route path="purchasing/requests/:id" element={<PurchaseRequestDetail />} />
        <Route path="purchasing/orders/:id" element={<PurchaseOrderDetail />} />
        <Route path="purchasing/suppliers/:id" element={<SupplierDetail />} />
        <Route path="changes" element={<Changes />} />
        <Route path="changes/new" element={<NewChange />} />
        <Route path="changes/:id" element={<ChangeDetail />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="training" element={<Training />} />
        <Route path="training/enrollments/:id" element={<EnrollmentDetail />} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/:id" element={<ReportView />} />
        <Route path="imports" element={<Imports />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return <AuthProvider><BrowserRouter><Routed /></BrowserRouter></AuthProvider>;
}
