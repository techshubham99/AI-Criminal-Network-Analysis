/**
 * Evidence integrity — the audit chain's verdict, on screen.
 *
 * Four things are worth pinning down here:
 *
 *  1. THE VERDICT IS THE BACKEND'S. `VERIFIED` and `INTEGRITY COMPROMISED` are
 *     rendered from the recorded response; the component never decides a status
 *     from a hash it computed itself.
 *  2. A FAILURE NAMES THE EVENT. A compromised chain shows which event broke and
 *     both hashes, because "something is wrong somewhere" is not an audit trail.
 *  3. VERIFY RE-ASKS THE BACKEND. The single action issues a second GET rather
 *     than re-rendering a cached answer — a stale tick is worse than no tick.
 *  4. A MISSING LEDGER SAYS SO. With `/audit` unavailable the panel reports that
 *     nothing was verified, and shows no tick at all.
 *
 * The recordings come from `backend/scripts/phase5_audit_demo.py`, so the hashes
 * asserted below are hashes the running ledger actually produced.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { defaultRoutes, fixtures, installFetch, installOfflineFetch } from '@/test/helpers';

import { LedgerIntegrity } from './LedgerIntegrity';

const verified = fixtures.auditVerify;
const compromised = fixtures.auditVerifyCompromised;

const status = () => screen.getByTestId('ledger-status');
const awaitStatus = () => waitFor(() => expect(status()).toBeInTheDocument());

describe('LedgerIntegrity', () => {
  it('reports a verified chain, with the head hash truncated', async () => {
    const { calls } = installFetch();
    render(<LedgerIntegrity />);
    await awaitStatus();

    expect(status()).toHaveTextContent('VERIFIED');
    expect(status()).not.toHaveTextContent('COMPROMISED');
    expect(calls.filter((url) => url.includes('/api/v1/audit/verify'))).toHaveLength(1);

    // The count is the backend's, not a length the component inferred.
    expect(
      screen.getByText(`${verified.events_checked} of ${verified.chain_length} events checked`),
    ).toBeInTheDocument();

    // Truncated on screen, full value available on hover — never a 64-char wall.
    const head = screen.getByTitle(verified.head_hash);
    expect(head).toHaveTextContent(verified.head_hash.slice(0, 12));
    expect(head.textContent).not.toBe(verified.head_hash);
    expect(screen.queryByTestId('ledger-failure')).toBeNull();
  });

  it('names the broken event and both hashes when the chain is compromised', async () => {
    installFetch([{ match: '/api/v1/audit/verify', body: compromised }]);
    render(<LedgerIntegrity />);
    await awaitStatus();

    expect(status()).toHaveTextContent('INTEGRITY COMPROMISED');
    const failure = screen.getByTestId('ledger-failure');
    expect(failure).toHaveTextContent(compromised.failure.audit_event_id);
    expect(failure).toHaveTextContent(compromised.failure.reason);
    expect(failure).toHaveTextContent(compromised.failure.expected_hash.slice(0, 12));
    expect(failure).toHaveTextContent(compromised.failure.actual_hash.slice(0, 12));
    // The two hashes differ on screen, which is the whole point of showing both.
    expect(compromised.failure.expected_hash).not.toBe(compromised.failure.actual_hash);
  });

  it('re-asks the backend when Verify is clicked', async () => {
    const { calls } = installFetch();
    render(<LedgerIntegrity />);
    await awaitStatus();
    const before = calls.length;

    fireEvent.click(screen.getByRole('button', { name: /verify the audit chain/i }));
    await waitFor(() => expect(calls.length).toBe(before + 1));
    expect(calls[calls.length - 1]).toContain('/api/v1/audit/verify');
    await awaitStatus();
  });

  it('says nothing was verified when the ledger is unreachable', async () => {
    installOfflineFetch();
    render(<LedgerIntegrity />);

    await waitFor(() =>
      expect(screen.getByText(/integrity ledger unavailable/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('ledger-status')).toBeNull();
    expect(screen.queryByText(/VERIFIED/)).toBeNull();
  });

  it('asks only for the verification route, and never for a write', async () => {
    const { calls } = installFetch();
    render(<LedgerIntegrity />);
    await awaitStatus();

    // §12: a read-only integrity view. It must not reach the ledger's write
    // route, and must not browse the event list to render a single verdict.
    expect(calls.every((url) => url.includes('/api/v1/audit/verify'))).toBe(true);
    expect(calls.some((url) => url.includes('/api/v1/audit/records'))).toBe(false);
    expect(calls.some((url) => url.includes('/api/v1/audit/events'))).toBe(false);
    // And the route it does use is one the default table serves, i.e. a real
    // recorded backend URL rather than a path invented for this component.
    expect(
      defaultRoutes().some((route) => String(route.match).includes('/api/v1/audit/verify')),
    ).toBe(true);
  });
});
