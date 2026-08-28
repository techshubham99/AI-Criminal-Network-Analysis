/**
 * The global Add Intelligence entry point: a compact header button that opens the
 * ingestion intake in a modal.
 *
 * The intake form itself is `AddIntelligence` — unchanged, and still the only
 * write surface in the application. This file adds nothing to the pipeline; it
 * only makes it reachable from every screen instead of from one page.
 *
 * No refresh is wired from here on purpose. An accepted record makes the backend
 * publish a `new_intelligence` event on the SSE stream, and the screens that care
 * already re-request on that event. Pushing a second, client-side refresh would
 * mean two sources of truth for "something changed".
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { AddIntelligence } from './AddIntelligence';
import { IconButton } from '@/components/ui';

export function AddIntelligenceButton(): ReactElement {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="open-intake"
        className="border-cyan-600/55 bg-cyan-500/14 text-cyan-200 hover:border-cyan-500/70 hover:bg-cyan-500/22 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-semibold transition-colors"
      >
        <span aria-hidden="true" className="text-sm leading-none">
          +
        </span>
        <span className="hidden lg:inline">Add Intelligence</span>
        <span className="lg:hidden">Add</span>
      </button>
      {open ? <IntakeModal onClose={close} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ modal -- */

function IntakeModal({ onClose }: { onClose: () => void }): ReactElement {
  const panel = useRef<HTMLDivElement>(null);

  /* Escape closes; the body stops scrolling behind the overlay. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="bg-void/80 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 backdrop-blur-sm sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="intake-modal"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Add intelligence"
        tabIndex={-1}
        className="elevation-3 w-full max-w-2xl outline-none"
      >
        <div className="border-line bg-panel flex items-center justify-between gap-3 rounded-t-md border border-b-0 px-4 py-2.5">
          <h2 className="text-ink text-sm font-bold">Add Intelligence</h2>
          <IconButton
            label="Close"
            onClick={onClose}
            icon={
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            }
          />
        </div>
        <AddIntelligence />
      </div>
    </div>
  );
}
