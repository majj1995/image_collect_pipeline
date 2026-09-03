import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.js";
import { JobsPage } from "./pages/JobsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { WorkbenchPage } from "./pages/WorkbenchPage.js";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<JobsPage />} />
        <Route path="/jobs/:jobId" element={<WorkbenchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppShell>
  );
}
