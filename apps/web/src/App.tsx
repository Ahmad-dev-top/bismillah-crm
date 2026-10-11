import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth.tsx";
import { Layout } from "./components/Layout.tsx";
import { Login } from "./pages/Login.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Customers } from "./pages/Customers.tsx";
import { CustomerProfile } from "./pages/CustomerProfile.tsx";
import { CustomerForm } from "./pages/CustomerForm.tsx";
import { Packages } from "./pages/Packages.tsx";
import { Areas } from "./pages/Areas.tsx";
import { Settings } from "./pages/Settings.tsx";

export default function App() {
  const { session } = useAuth();

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/new" element={<CustomerForm />} />
        <Route path="/customers/:id" element={<CustomerProfile />} />
        <Route path="/customers/:id/edit" element={<CustomerForm />} />
        <Route path="/packages" element={<Packages />} />
        <Route path="/areas" element={<Areas />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
