import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/layouts/AppShell';
import { CommandCenter } from '@/pages/CommandCenter';
import { InvestigationsPage } from '@/pages/InvestigationsPage';
import { NetworkInvestigation } from '@/pages/NetworkInvestigation';
import { FirIntelligence } from '@/pages/FirIntelligence';
import { CommunicationPage } from '@/pages/CommunicationPage';
import { FinancialPage } from '@/pages/FinancialPage';
import { LocationsPage } from '@/pages/LocationsPage';
import { EvidencePage } from '@/pages/EvidencePage';
import { AlertsPage } from '@/pages/AlertsPage';
import { Button, EmptyState } from '@/components/ui';

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export function App() {
  return (
    <AppErrorBoundary>
      <Routes>
        <Route element={<ShellLayout />}>
          <Route path="/" element={<CommandCenter />} />
          <Route path="/investigations" element={<InvestigationsPage />} />
          <Route path="/network" element={<NetworkInvestigation />} />
          <Route path="/network/:personId" element={<NetworkInvestigation />} />
          <Route path="/fir" element={<FirIntelligence />} />
          <Route path="/fir/:firId" element={<FirIntelligence />} />
          <Route path="/communication" element={<CommunicationPage />} />
          <Route path="/financial" element={<FinancialPage />} />
          <Route path="/locations" element={<LocationsPage />} />
          <Route path="/evidence" element={<EvidencePage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/firs" element={<Navigate to="/fir" replace />} />
          <Route path="*" element={<RouteNotFound />} />
        </Route>
      </Routes>
    </AppErrorBoundary>
  );
}

function RouteNotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="Use the sidebar to navigate."
      action={
        <Link to="/">
          <Button variant="primary">Command Center</Button>
        </Link>
      }
    />
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render failure in', info.componentStack?.split('\n')[1]?.trim(), error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="bg-void flex min-h-screen items-center justify-center p-8">
        <div
          role="alert"
          className="border-alert-500/30 bg-alert-900/20 max-w-lg rounded-lg border px-5 py-5"
        >
          <p className="text-alert-300 text-sm font-semibold">Interface error</p>
          <p className="text-ink-3 mt-2 text-xs leading-relaxed">
            A view failed to render. Reload to recover.
          </p>
          <p className="text-ink-4 mt-2 font-mono text-2xs break-words">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="border-alert-500/35 bg-alert-500/10 text-alert-300 hover:bg-alert-500/18 mt-4 rounded-sm border px-3 py-1.5 text-xs font-semibold transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
