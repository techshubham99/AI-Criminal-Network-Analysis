/**
 * LedgerIntegrity — one line of truth about the audit chain.
 *
 * The backend keeps a local hash chain of investigation events; this asks it to
 * recompute that chain and reports the answer verbatim. Two states only, because
 * the ledger returns two: VERIFIED, or INTEGRITY COMPROMISED with the event that
 * broke and both hashes.
 *
 * It is a status line, not a ledger browser: no event feed, no block explorer,
 * no chain diagram. If the ledger is switched off or unreachable it says so in
 * one muted sentence instead of showing a reassuring green tick.
 */
import type { ReactElement } from 'react';

import { api } from '@/api';
import { Badge, Button, Mono, Panel, PanelBody, PanelHeader } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import type { ChainVerificationOut } from '@/types/api';

const HASH_CHARS = 12;

function short(hash: string): string {
  return hash.length > HASH_CHARS ? `${hash.slice(0, HASH_CHARS)}…` : hash;
}

export function LedgerIntegrity({ className }: { className?: string }): ReactElement {
  const chain = useAsync<ChainVerificationOut>((signal) => api.verifyAuditChain({ signal }), []);
  const result = chain.data;
  const compromised = result?.status === 'INTEGRITY_COMPROMISED';

  return (
    <Panel className={className} data-testid="ledger-integrity">
      <PanelHeader
        title="Evidence integrity"
        subtitle="Tamper-evident audit ledger over ingestion decisions and evidence hashes."
        actions={
          <Button
            size="sm"
            onClick={chain.retry}
            loading={chain.isLoading}
            aria-label="Verify the audit chain"
          >
            Verify
          </Button>
        }
      />
      <PanelBody className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        {chain.error ? (
          <p className="text-ink-4 text-xs">
            Integrity ledger unavailable ({chain.error.status || 'offline'}). Nothing was verified.
          </p>
        ) : result ? (
          <>
            <Badge tone={compromised ? 'alert' : 'ok'} className="shrink-0">
              <span data-testid="ledger-status">
                {compromised ? '⚠ INTEGRITY COMPROMISED' : '✓ VERIFIED'}
              </span>
            </Badge>
            <span className="text-ink-3 text-xs">
              {`${result.events_checked} of ${result.chain_length} event${
                result.chain_length === 1 ? '' : 's'
              } checked`}
            </span>
            <span className="text-ink-4 text-2xs flex items-center gap-1.5">
              head
              <Mono title={result.head_hash}>{short(result.head_hash)}</Mono>
            </span>
            {compromised && result.failure ? (
              <p
                className="text-alert-300 flex basis-full flex-wrap gap-x-2 text-xs"
                data-testid="ledger-failure"
              >
                <span className="font-semibold">{result.failure.audit_event_id ?? 'chain'}</span>
                <span>{result.failure.reason}</span>
                <span className="text-ink-4">
                  expected <Mono>{short(result.failure.expected_hash ?? '')}</Mono> got{' '}
                  <Mono>{short(result.failure.actual_hash ?? '')}</Mono>
                </span>
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-ink-4 text-xs">Checking the audit chain…</p>
        )}
      </PanelBody>
    </Panel>
  );
}
