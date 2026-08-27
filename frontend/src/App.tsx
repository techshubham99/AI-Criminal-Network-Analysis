import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/layouts/AppShell';
import { CommandCenter } from '@/pages/CommandCenter';
import { NetworkInvestigation } from '@/pages/NetworkInvestigation';
import { FirIntelligence } from '@/pages/FirIntelligence';
import { EvidencePage } from '@/pages/EvidencePage';
import { Button, EmptyState, SectionHeading } from '@/components/ui';

/**
 * Routes.
 *
 * Every route here is backed by verified backend endpoints — there are no
 * placeholder screens. Risk scoring and the audit ledger belong to later phases
 * and deliberately have no nav entry.
 *
 * The network and FIR views take an optional path parameter so an investigation
 * is deep-linkable and the browser's back button steps through the trail. Both
 * params are the backend's NUMERIC row id (`/network/445`, `/fir/79`), matching
 * the path-parameter form those endpoints actually parse — see the TWO ID FORMS
 * note in `src/api/endpoints.ts`. Nothing URL-encoded ever needs to appear here.
 */
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
          <Route path="/network" element={<NetworkInvestigation />} />
          <Route path="/network/:personId" element={<NetworkInvestigation />} />
          <Route path="/fir" element={<FirIntelligence />} />
          <Route path="/fir/:firId" element={<FirIntelligence />} />
          <Route path="/evidence" element={<EvidencePage />} />
          {/* Keep old-style singular paths working rather than 404ing a demo. */}
          <Route path="/firs" element={<Navigate to="/fir" replace />} />
          <Route path="*" element={<RouteNotFound />} />
        </Route>
      </Routes>
    </AppErrorBoundary>
  );
}

function RouteNotFound() {
  return (
    <div className="space-y-5">
      <SectionHeading
        title="Screen not found"
        subtitle="That address does not correspond to a view in this prototype."
      />
      <EmptyState
        title="No such screen"
        description="This build exposes only the four views backed by verified backend endpoints: Command Center, Network Investigation, FIR Intelligence, and Evidence & Provenance."
        action={
          <Link to="/">
            <Button variant="primary">Return to Command Center</Button>
          </Link>
        }
      />
    </div>
  );
}

/**
 * A render-time failure should degrade to a readable message instead of a blank
 * page — a white screen during a demo is indistinguishable from a crashed backend,
 * and the two need very different responses.
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Component stack only — never log response payloads, which can carry
    // personal data from the case records.
    console.error('Render failure in', info.componentStack?.split('\n')[1]?.trim(), error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="bg-void flex min-h-screen items-center justify-center p-8">
        <div
          role="alert"
          className="border-alert-500/35 bg-alert-900/25 max-w-xl rounded-lg border px-5 py-5"
        >
          <p className="text-alert-300 text-sm font-semibold">Interface error</p>
          <p className="text-ink-2 mt-2 text-xs leading-relaxed">
            A view failed to render. The backend is unaffected — reload the page to recover.
          </p>
          <p className="text-ink-4 mt-2 font-mono text-2xs break-words">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="border-alert-500/40 bg-alert-500/10 text-alert-300 hover:bg-alert-500/18 mt-4 rounded-sm border px-2.5 py-1 text-xs font-semibold transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
