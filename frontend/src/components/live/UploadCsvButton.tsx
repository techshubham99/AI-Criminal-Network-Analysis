/**
 * The global Upload CSV entry point: a compact header button that opens the bulk
 * import in a modal.
 *
 * This file adds nothing to the pipeline; it only makes it reachable from every
 * screen. The flow itself is `CsvImport`, which previews a file before anything
 * is written and commits only on an explicit decision.
 *
 * No refresh is wired from here on purpose. A committed import makes the backend
 * publish on the SSE stream, and the screens that care already re-request on that
 * event. Pushing a second, client-side refresh would mean two sources of truth
 * for "something changed".
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { CsvImport } from './CsvImport';
import { IconButton } from '@/components/ui';

export function UploadCsvButton(): ReactElement {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="open-upload"
        className="border-cyan-600/55 bg-cyan-500/14 text-cyan-200 hover:border-cyan-500/70 hover:bg-cyan-500/22 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-semibold transition-colors"
      >
        <span aria-hidden="true" className="text-sm leading-none">
          ↑
        </span>
        <span className="hidden lg:inline">Upload CSV</span>
        <span className="lg:hidden">Upload</span>
      </button>
      {open ? <UploadModal onClose={close} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ modal -- */

/**
 * The dialog is rendered into `document.body` through a portal, and that is not
 * cosmetic: this button lives in the top bar, and the top bar sets
 * `backdrop-blur-xl`. A `backdrop-filter` makes its element a containing block
 * for fixed-position descendants, so a `fixed inset-0` overlay nested inside the
 * header resolves to the header's own 52px-tall box — the backdrop covers a
 * strip, the overlay's scroll area clips the form out of view, and what is left
 * on screen is a bar stuck to the top of the page. Portalling past the header is
 * the fix; `inset-0` then means the viewport, as it reads.
 */
function UploadModal({ onClose }: { onClose: () => void }): ReactElement {
  const panel = useRef<HTMLDivElement>(null);

  /* Escape closes; whatever scrolls behind the overlay stops scrolling. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    /*
     * `AppShell` is a fixed-height column whose `<main>` owns the scrollbar, so
     * locking `body` alone leaves the page moving behind the dialog. Lock both:
     * the document scrolls on any screen rendered outside the shell.
     */
    const locked = [document.body, document.getElementById('main')].filter(
      (element): element is HTMLElement => element !== null,
    );
    const previous = locked.map((element) => element.style.overflow);
    for (const element of locked) element.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      locked.forEach((element, index) => {
        element.style.overflow = previous[index];
      });
    };
  }, [onClose]);

  return createPortal(
    <div
      className="bg-void/80 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain p-4 backdrop-blur-sm sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="upload-modal"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Upload CSV"
        tabIndex={-1}
        className="elevation-3 w-full max-w-6xl outline-none"
      >
        <div className="border-line bg-panel flex items-center justify-between gap-3 rounded-t-md border border-b-0 px-4 py-2.5">
          <h2 className="text-ink text-sm font-bold">Upload CSV</h2>
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
        <CsvImport onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
