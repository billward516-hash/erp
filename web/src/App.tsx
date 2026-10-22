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
import { Integrations } from './pages/Integrations';
import { Time, TimesheetDetail } from './pages/Time';
import { Notifications } from './pages/Notifications';
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
        <Route path="ap/new" element={<CaptureInvoice />} />
        <Route path="ap/:id" element={<InvoiceDetail />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="notifications" element={<Notifications />} />
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
