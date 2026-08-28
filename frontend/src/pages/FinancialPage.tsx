/**
 * Financial — an independent product area, not a tab of the network page.
 *
 * Corpus-wide by default: the transaction record table with the mode filter the
 * backend offers, and the totals for each transaction pattern category. Scoped to
 * a subject on request: money in, money out, counterparties, and the fan-in,
 * fan-out, cycle and concentration patterns the engine derived for them.
 *
 * A detected pattern is a *potential* pattern and is labelled that way. The engine
 * reports structure in transaction records; it does not adjudicate what the
 * structure means, and neither does this screen.
 *
 * Amounts are summed only over rows actually fetched. When the backend says there
 * are more pages than were read, the figure is labelled partial rather than
 * presented as a total.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '@/api';
import { PatternDetails, PatternList } from '@/components/intelligence';
import { Cell, DataTable, Pager, PersonRef, SubjectScope } from '@/components/records';
import {
  Badge,
  EmptyState,
  ErrorState,
  Panel,
  PanelBody,
  PanelHeader,
  SegmentedControl,
  SkeletonRows,
  SkeletonTile,
  StatTile,
} from '@/components/ui';
import { useAsync, type AsyncState } from '@/hooks/useAsync';
import { useLive } from '@/hooks/useLive';
import { usePersonNames, type PersonNames } from '@/hooks/usePersonNames';
import { usePersonScope } from '@/hooks/usePersonScope';
import type { Page, TransactionRecord } from '@/types/api';
import { formatCount, formatDateTime, formatInr } from '@/utils/format';

const PAGE_SIZE = 25;

/** The server-side cap (`MAX_PAGE_SIZE`). Asking for more returns HTTP 422. */
const MAX_PAGE_SIZE = 200;

/** The four categories the pattern engine derives from transaction records. */
const FINANCIAL_PATTERNS = [
  'TRANSACTION_FAN_IN',
  'TRANSACTION_FAN_OUT',
  'TRANSACTION_CYCLE',
  'TRANSACTION_CONCENTRATION',
] as const;

/** The modes present in this dataset. Passed straight through as `?mode=`. */
const MODES = ['', 'UPI', 'NEFT', 'IMPS', 'CASH', 'CARD'] as const;

/* ============================================================ route */

export function FinancialPage(): ReactElement {
  const { personId, setPersonId } = usePersonScope();
  const names = usePersonNames();

  return (
    <div className="space-y-4 pb-8 animate-fade-in" data-testid="financial-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ink text-base font-bold tracking-tight">Financial</h1>
      </div>

      <SubjectScope personId={personId} label={names.nameOf(personId)} onChange={setPersonId} />

      {personId === null ? <CorpusFinancial /> : <PersonFinancial personId={personId} />}
    </div>
  );
}

/* ============================================================ corpus-wide */

function CorpusFinancial(): ReactElement {
  const [params, setParams] = useSearchParams();
  const rawPage = params.get('page');
  const page = rawPage !== null && /^\d+$/.test(rawPage) ? Math.max(1, Number(rawPage)) : 1;
  const mode = params.get('mode') ?? '';
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null);

  const transactions = useAsync(
    (signal) =>
      api.listTransactions({ page, page_size: PAGE_SIZE, mode: mode || undefined }, { signal }),
    [page, mode],
  );
  const fanIn = useAsync(
    (signal) => api.listPatterns({ pattern_type: 'TRANSACTION_FAN_IN', limit: 1 }, { signal }),
    [],
  );
  const fanOut = useAsync(
    (signal) => api.listPatterns({ pattern_type: 'TRANSACTION_FAN_OUT', limit: 1 }, { signal }),
    [],
  );
  const cycles = useAsync(
    (signal) => api.listPatterns({ pattern_type: 'TRANSACTION_CYCLE', limit: 1 }, { signal }),
    [],
  );
  const concentration = useAsync(
    (signal) =>
      api.listPatterns({ pattern_type: 'TRANSACTION_CONCENTRATION', limit: 1 }, { signal }),
    [],
  );

  const update = (key: string, value: string) => {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (value) updated.set(key, value);
        else updated.delete(key);
        if (key !== 'page') updated.delete('page');
        return updated;
      },
      { replace: true },
    );
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {transactions.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Transactions"
            value={formatCount(transactions.data?.meta.total)}
            accent="cyan"
          />
        )}
        {fanIn.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile label="Fan-in" value={formatCount(fanIn.data?.total)} accent="azure" />
        )}
        {fanOut.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile label="Fan-out" value={formatCount(fanOut.data?.total)} accent="azure" />
        )}
        {cycles.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile label="Circular" value={formatCount(cycles.data?.total)} accent="warn" />
        )}
        {concentration.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Concentration"
            value={formatCount(concentration.data?.total)}
            accent="warn"
          />
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <TransactionTable
          title="Transaction records"
          state={transactions}
          onPage={(next) => update('page', String(next))}
          actions={
            <SegmentedControl
              label="Payment mode"
              value={mode}
              onChange={(next) => update('mode', next)}
              options={MODES.map((value) => ({ value, label: value || 'All' }))}
            />
          }
        />
        <div className="space-y-4">
          <PatternList
            title="Potential transaction patterns"
            types={FINANCIAL_PATTERNS}
            limit={10}
            selectedId={selectedPattern}
            onSelect={setSelectedPattern}
          />
          {selectedPattern ? <PatternDetails patternId={selectedPattern} /> : null}
        </div>
      </div>
    </>
  );
}

/* ============================================================ person-scoped */

/**
 * One subject's financial picture. Exported so the investigation workspace's
 * Financial tab renders exactly this screen rather than a second copy of it.
 */
export function PersonFinancial({ personId }: { personId: number }): ReactElement {
  const names = usePersonNames();
  const [refreshKey, setRefreshKey] = useState(0);

  useLive((event) => {
    if (event.event_type === 'new_intelligence') setRefreshKey((key) => key + 1);
  });

  const sent = useAsync(
    (signal) => api.listTransactions({ sender_id: personId, page_size: MAX_PAGE_SIZE }, { signal }),
    [personId, refreshKey],
  );
  const received = useAsync(
    (signal) =>
      api.listTransactions({ receiver_id: personId, page_size: MAX_PAGE_SIZE }, { signal }),
    [personId, refreshKey],
  );

  const outRows = sent.data?.items ?? [];
  const inRows = received.data?.items ?? [];
  const partial = (sent.data?.meta.has_next ?? false) || (received.data?.meta.has_next ?? false);
  const loaded = sent.data !== null && received.data !== null;

  const outgoing = outRows.reduce((total, row) => total + (row.amount_inr ?? 0), 0);
  const incoming = inRows.reduce((total, row) => total + (row.amount_inr ?? 0), 0);
  const count =
    loaded && sent.data && received.data ? sent.data.meta.total + received.data.meta.total : null;

  const rows = useMemo(
    () => [...outRows, ...inRows].sort((a, b) => b.txn_time.localeCompare(a.txn_time)),
    [outRows, inRows],
  );
  const counterparties = useMemo(
    () => rankCounterparties(outRows, inRows, personId),
    [outRows, inRows, personId],
  );

  const amountFootnote = partial ? `First ${formatCount(rows.length)} records` : undefined;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Incoming"
          value={loaded ? formatInr(incoming) : '—'}
          footnote={amountFootnote}
          accent="ok"
        />
        <StatTile
          label="Outgoing"
          value={loaded ? formatInr(outgoing) : '—'}
          footnote={amountFootnote}
          accent="warn"
        />
        <StatTile
          label="Transactions"
          value={count === null ? '—' : formatCount(count)}
          accent="cyan"
        />
        <StatTile
          label="Counterparties"
          value={loaded ? formatCount(counterparties.length) : '—'}
          accent="azure"
        />
      </div>

      {partial ? (
        <p className="text-ink-4 text-2xs" data-testid="financial-partial">
          Amounts cover the {formatCount(rows.length)} records read; the backend reports more.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Panel data-testid="transaction-timeline">
            <PanelHeader title="Transaction timeline" accent />
            <PanelBody padded={false}>
              {sent.isInitialLoading || received.isInitialLoading ? (
                <SkeletonRows rows={8} className="p-3" />
              ) : null}
              {sent.error ? <ErrorState error={sent.error} onRetry={sent.retry} compact /> : null}
              {received.error ? (
                <ErrorState error={received.error} onRetry={received.retry} compact />
              ) : null}
              {loaded && rows.length === 0 ? (
                <EmptyState
                  title="No transactions on record"
                  description="No data available for this subject."
                />
              ) : null}
              {rows.length > 0 ? (
                <TransactionRows rows={rows} names={names} subjectId={personId} />
              ) : null}
            </PanelBody>
          </Panel>

          <Counterparties items={counterparties} loading={!loaded} />
        </div>

        <PatternList
          title="Potential transaction patterns"
          types={FINANCIAL_PATTERNS}
          entityId={`person:${personId}`}
          limit={10}
          refreshKey={refreshKey}
        />
      </div>
    </>
  );
}

/* ============================================================ pieces */

interface Counterparty {
  personId: number;
  sentTo: number;
  receivedFrom: number;
  count: number;
}

/** Both directions, grouped by the other party. Sorted by total value moved. */
function rankCounterparties(
  outRows: TransactionRecord[],
  inRows: TransactionRecord[],
  subjectId: number,
): Counterparty[] {
  const byPerson = new Map<number, Counterparty>();

  const touch = (id: number): Counterparty => {
    let entry = byPerson.get(id);
    if (!entry) {
      entry = { personId: id, sentTo: 0, receivedFrom: 0, count: 0 };
      byPerson.set(id, entry);
    }
    return entry;
  };

  for (const row of outRows) {
    if (row.receiver_id === subjectId) continue;
    const entry = touch(row.receiver_id);
    entry.sentTo += row.amount_inr ?? 0;
    entry.count += 1;
  }
  for (const row of inRows) {
    if (row.sender_id === subjectId) continue;
    const entry = touch(row.sender_id);
    entry.receivedFrom += row.amount_inr ?? 0;
    entry.count += 1;
  }

  return [...byPerson.values()].sort(
    (a, b) => b.sentTo + b.receivedFrom - (a.sentTo + a.receivedFrom),
  );
}

function Counterparties({
  items,
  loading,
}: {
  items: Counterparty[];
  loading: boolean;
}): ReactElement {
  const names = usePersonNames();
  return (
    <Panel data-testid="counterparties">
      <PanelHeader title="Counterparties" accent />
      <PanelBody padded={false}>
        {loading ? <SkeletonRows rows={5} className="p-3" /> : null}
        {!loading && items.length === 0 ? (
          <EmptyState title="No counterparties" description="No data available for this subject." />
        ) : null}
        {items.length > 0 ? (
          <DataTable head={['Counterparty', 'Sent to', 'Received from', 'Records']}>
            {items.map((item) => (
              <tr
                key={item.personId}
                className="hover:bg-panel-2 transition-colors"
                data-testid="counterparty-row"
              >
                <Cell>
                  <PersonRef personId={item.personId} names={names} />
                </Cell>
                <Cell numeric>{item.sentTo > 0 ? formatInr(item.sentTo) : '—'}</Cell>
                <Cell numeric>{item.receivedFrom > 0 ? formatInr(item.receivedFrom) : '—'}</Cell>
                <Cell numeric>{formatCount(item.count)}</Cell>
              </tr>
            ))}
          </DataTable>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* ------------------------------------------------------ transaction tables -- */

function TransactionRows({
  rows,
  names,
  subjectId,
}: {
  rows: TransactionRecord[];
  names: PersonNames;
  subjectId?: number;
}): ReactElement {
  const head = subjectId === undefined
    ? ['Txn', 'Time', 'Sender', 'Receiver', 'Amount', 'Mode', 'Bank ref']
    : ['Txn', 'Time', 'Dir', 'Counterparty', 'Amount', 'Mode', 'Bank ref'];

  return (
    <DataTable head={head}>
      {rows.map((row) => {
        const outbound = row.sender_id === subjectId;
        const other = outbound ? row.receiver_id : row.sender_id;
        return (
          <tr
            key={row.txn_id}
            className="hover:bg-panel-2 transition-colors"
            data-testid="transaction-row"
          >
            <Cell numeric>{row.txn_id}</Cell>
            <Cell>
              <span className="font-mono text-2xs">{formatDateTime(row.txn_time)}</span>
            </Cell>
            {subjectId === undefined ? (
              <>
                <Cell>
                  <PersonRef personId={row.sender_id} names={names} />
                </Cell>
                <Cell>
                  <PersonRef personId={row.receiver_id} names={names} />
                </Cell>
              </>
            ) : (
              <>
                <Cell>
                  <Badge tone={outbound ? 'warn' : 'ok'}>{outbound ? 'OUT' : 'IN'}</Badge>
                </Cell>
                <Cell>
                  <PersonRef personId={other} names={names} />
                </Cell>
              </>
            )}
            <Cell numeric>{formatInr(row.amount_inr)}</Cell>
            <Cell>
              <span className="text-ink-2 text-2xs font-semibold">{row.mode}</span>
            </Cell>
            <Cell>
              <span className="text-ink-4 font-mono text-2xs">{row.bank_ref}</span>
            </Cell>
          </tr>
        );
      })}
    </DataTable>
  );
}

function TransactionTable({
  title,
  state,
  onPage,
  actions,
}: {
  title: string;
  state: AsyncState<Page<TransactionRecord>>;
  onPage: (page: number) => void;
  actions?: ReactElement;
}): ReactElement {
  const names = usePersonNames();
  return (
    <Panel data-testid="transaction-table">
      <PanelHeader title={title} accent actions={actions} />
      <PanelBody padded={false}>
        {state.isInitialLoading ? <SkeletonRows rows={8} className="p-3" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.retry} compact /> : null}
        {state.data && state.data.items.length === 0 ? (
          <EmptyState title="No transactions" description="No data available for this filter." />
        ) : null}
        {state.data && state.data.items.length > 0 ? (
          <TransactionRows rows={state.data.items} names={names} />
        ) : null}
      </PanelBody>
      <Pager
        meta={state.data?.meta ?? null}
        onPage={onPage}
        isLoading={state.isLoading}
        unit="transactions"
      />
    </Panel>
  );
}
