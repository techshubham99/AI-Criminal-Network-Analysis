/**
 * Financial — §2: an independent product area with its own records, its own
 * filters and its own patterns.
 *
 * The wording matters as much as the numbers here. The engine reports structure in
 * transaction records; it does not adjudicate what that structure means. So the
 * panel says "potential", and the word "laundering" appears nowhere — that is
 * asserted, not left to review.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetPersonNames } from '@/hooks/usePersonNames';
import { fixtures, installFetch, renderWithRouter, statTile } from '@/test/helpers';
import type { Page, PatternListResponse, TransactionRecord } from '@/types/api';
import { formatCount, formatInr } from '@/utils/format';

import { FinancialPage } from './FinancialPage';

const allTransactions = fixtures.transactionsPage1 as unknown as Page<TransactionRecord>;
const sent = fixtures.transactionsSender445 as unknown as Page<TransactionRecord>;
const received = fixtures.transactionsReceiver445 as unknown as Page<TransactionRecord>;
const fanIn = fixtures.patternsFanIn as unknown as PatternListResponse;
const fanOut = fixtures.patternsFanOut as unknown as PatternListResponse;
const cycles = fixtures.patternsCycle as unknown as PatternListResponse;
const concentration = fixtures.patternsConcentration as unknown as PatternListResponse;

const sum = (rows: TransactionRecord[]) => rows.reduce((total, row) => total + row.amount_inr, 0);

/** Both directions, by the other party — five distinct people in the recording. */
const counterparties = new Set([
  ...sent.items.map((row) => row.receiver_id),
  ...received.items.map((row) => row.sender_id),
]);

describe('Financial — the corpus-wide browse', () => {
  beforeEach(resetPersonNames);

  it('is a page of transaction records, not a network waiting for a person', async () => {
    const { calls } = installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial' });

    await waitFor(() =>
      expect(screen.getAllByTestId('transaction-row')).toHaveLength(allTransactions.items.length),
    );

    expect(screen.getByTestId('financial-page')).toBeInTheDocument();
    expect(screen.getByTestId('transaction-table')).toBeInTheDocument();
    expect(screen.getByTestId('scope-search')).toBeInTheDocument();
    expect(calls.some((url) => url.includes('/api/v1/transactions?page=1&page_size=25'))).toBe(true);
    expect(calls.some((url) => url.includes('/graph/persons/'))).toBe(false);
  });

  it('shows one tile per pattern category the engine derives from transactions', async () => {
    installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial' });

    await waitFor(() =>
      expect(statTile('Transactions')).toHaveTextContent(
        formatCount(allTransactions.meta.total),
      ),
    );
    expect(statTile('Fan-in')).toHaveTextContent(formatCount(fanIn.total));
    expect(statTile('Fan-out')).toHaveTextContent(formatCount(fanOut.total));
    expect(statTile('Circular')).toHaveTextContent(formatCount(cycles.total));
    expect(statTile('Concentration')).toHaveTextContent(formatCount(concentration.total));
  });

  it('passes the payment-mode filter through to the backend', async () => {
    const { calls } = installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial' });

    const modes = await screen.findByRole('radiogroup', { name: 'Payment mode' });
    fireEvent.click(within(modes).getByRole('radio', { name: 'UPI' }));

    // The filter is the backend's own `?mode=`; nothing is filtered client-side.
    await waitFor(() =>
      expect(calls.some((url) => url.includes('/api/v1/transactions?') && url.includes('mode=UPI'))).toBe(
        true,
      ),
    );
  });

  it('asks for its four pattern categories, and calls what it finds potential', async () => {
    const { calls } = installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial' });

    const panel = await screen.findByTestId('pattern-list');
    for (const type of [
      'TRANSACTION_FAN_IN',
      'TRANSACTION_FAN_OUT',
      'TRANSACTION_CYCLE',
      'TRANSACTION_CONCENTRATION',
    ]) {
      await waitFor(() =>
        expect(
          calls.filter((url) => url.includes(`pattern_type=${type}`) && url.includes('limit=10')),
        ).toHaveLength(1),
      );
    }

    await waitFor(() => expect(within(panel).getAllByTestId('pattern-row')).toHaveLength(10));
    expect(within(panel).queryByText('No patterns detected')).not.toBeInTheDocument();
    expect(panel).toHaveTextContent(
      formatCount(fanIn.total + fanOut.total + cycles.total + concentration.total),
    );

    // A detected structure is a lead, not a finding of fact.
    expect(screen.getAllByText('Potential transaction patterns').length).toBeGreaterThan(0);
    expect(screen.queryByText(/launder/i)).not.toBeInTheDocument();
  });
});

describe('Financial — scoped to one subject', () => {
  beforeEach(resetPersonNames);

  it('sums each direction from the records it actually read', async () => {
    const { calls } = installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial?person=445' });

    await waitFor(() =>
      expect(statTile('Incoming')).toHaveTextContent(formatInr(sum(received.items))),
    );
    expect(statTile('Outgoing')).toHaveTextContent(formatInr(sum(sent.items)));

    // Both directions are asked for at the server's maximum page size, so the
    // sums cover every record rather than the first screenful.
    expect(
      calls.some((url) => url.includes('/api/v1/transactions?sender_id=445&page_size=200')),
    ).toBe(true);
    expect(
      calls.some((url) => url.includes('/api/v1/transactions?receiver_id=445&page_size=200')),
    ).toBe(true);

    // Neither slice has another page, so nothing is labelled partial.
    expect(sent.meta.has_next || received.meta.has_next).toBe(false);
    expect(screen.queryByTestId('financial-partial')).not.toBeInTheDocument();
  });

  it('counts transactions from the backend’s totals and counterparties from the rows', async () => {
    installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial?person=445' });

    await waitFor(() =>
      expect(statTile('Transactions')).toHaveTextContent(
        formatCount(sent.meta.total + received.meta.total),
      ),
    );
    expect(statTile('Counterparties')).toHaveTextContent(formatCount(counterparties.size));
    expect(screen.getAllByTestId('counterparty-row')).toHaveLength(counterparties.size);
  });

  it('marks the direction of every row in the subject’s timeline', async () => {
    installFetch();
    renderWithRouter(<FinancialPage />, { route: '/financial?person=445' });

    const timeline = await screen.findByTestId('transaction-timeline');
    await waitFor(() =>
      expect(within(timeline).getAllByTestId('transaction-row')).toHaveLength(
        sent.items.length + received.items.length,
      ),
    );
    expect(within(timeline).getAllByText('OUT')).toHaveLength(sent.items.length);
    expect(within(timeline).getAllByText('IN')).toHaveLength(received.items.length);
  });
});
