import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { cn } from '@/utils/cn';

/**
 * ErrorState — says what actually failed and offers the one useful action.
 *
 * The backend's error envelope carries a code and message; both are shown,
 * because "Person '99999' not found" is more use to an investigator than
 * "Something went wrong". Red is used here — this is exactly the alert case the
 * palette reserves it for.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  className,
  compact = false,
}: {
  error: ApiError | Error | null;
  onRetry?: () => void;
  title?: string;
  className?: string;
  compact?: boolean;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const heading = title ?? headingFor(apiError);

  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border border-alert-500/35 bg-alert-900/25',
        compact ? 'px-3 py-2.5' : 'px-4 py-4',
        className,
      )}
      data-testid="error-state"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 text-alert-400">
          <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4.5Zm0 6.25a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-alert-300 text-sm font-semibold">{heading}</p>
          <p className="text-ink-2 mt-1 text-xs break-words">
            {error?.message ?? 'No further detail was returned.'}
          </p>
          {apiError ? (
            <p className="text-ink-4 mt-1.5 font-mono text-2xs break-all">
              {apiError.status > 0 ? `HTTP ${apiError.status} · ` : ''}
              {apiError.code} · {apiError.url}
            </p>
          ) : null}
          {apiError?.kind === 'offline' ? (
            <p className="text-ink-3 mt-2 text-xs">
              Start the backend, then retry:{' '}
              <code className="text-cyan-300">
                python -m uvicorn app.main:app --reload --port 8000
              </code>
            </p>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-alert-500/40 bg-alert-500/10 px-2.5 py-1 text-xs font-semibold text-alert-300 transition-colors hover:bg-alert-500/18"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
                <path d="M8 3V1L4.5 3.75 8 6.5v-2a3.5 3.5 0 1 1-3.5 3.5H3a5 5 0 1 0 5-5Z" />
              </svg>
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function headingFor(error: ApiError | null): string {
  switch (error?.kind) {
    case 'offline':
      return 'Backend unreachable';
    case 'not_found':
      return 'Not found';
    case 'validation':
      return 'Invalid request';
    case 'bad_request':
      return 'Request rejected';
    case 'server':
      return 'Backend error';
    default:
      return 'Request failed';
  }
}

/**
 * EmptyState — for a successful request that legitimately has nothing to show.
 * Distinct from an error on purpose: "0 results" is an answer, and several of
 * this dataset's honest answers are zero.
 */
export function EmptyState({
  title,
  description,
  action,
  icon = 'empty',
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: 'empty' | 'search' | 'graph';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-inset/40 px-6 py-10 text-center',
        className,
      )}
      data-testid="empty-state"
    >
      <span aria-hidden className="text-ink-4">
        {icon === 'search' ? (
          <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="10.5" cy="10.5" r="6.25" />
            <path d="m15.2 15.2 4.3 4.3" strokeLinecap="round" />
          </svg>
        ) : icon === 'graph' ? (
          <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="5" cy="6" r="2.25" />
            <circle cx="19" cy="8" r="2.25" />
            <circle cx="11" cy="18" r="2.25" />
            <path d="M7 7 17 8M6.5 8 10 15.8M17.6 9.9 12.4 16.4" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2" />
            <path d="M3.75 10.5h16.5" />
          </svg>
        )}
      </span>
      <p className="text-ink mt-3 text-sm font-semibold">{title}</p>
      {description ? (
        <p className="text-ink-3 mt-1.5 max-w-md text-xs leading-relaxed">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
