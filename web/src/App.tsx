import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Approvals } from './pages/Approvals';
import { AssetDetail, AssetByQr, Assets } from './pages/Assets';
import { ChangeDetail, Changes, NewChange } from './pages/Changes';
import { Home } from './pages/Home';
import { Imports } from './pages/Imports';
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
