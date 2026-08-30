/**
 * CSV import — see what a file would do to the graph before any of it is written.
 *
 * The upload is judged, not applied. The backend classifies every row and then
 * computes the metrics, network and patterns that committing it *would* produce,
 * on an in-memory overlay; the live graph, the live store and the audit ledger
 * are untouched until [Add to System]. Duplicates are excluded automatically and
 * listed, never asked about one at a time.
 *
 * Two modes, one screen. **Single Type** posts one file to the per-type route and
 * is unchanged by Phase 6.2b. **All Types** posts up to four files of different
 * types to the combined route, which analyses them *together* on one overlay —
 * so a pair who exchange a call in one file and money in another shows up as a
 * multi-channel relationship before either file is committed. Everything below
 * the upload row is then the same dashboard, reading the same fields, with a
 * per-file summary added.
 *
 * The six checkmarks come only from `bulk_preview` frames on the existing SSE
 * channel, matched on the import id the backend puts in every frame — one
 * sequence for the whole selection, however many files it holds. There is no
 * client-side timer: a stage lights up because the backend finished it.
 *
 * The dashboard is the same components the rest of the app uses — the stat
 * tiles, the Cytoscape canvas, and tables built from the same preview payload:
 * the detectors' findings grouped into one tab per Phase 4 pattern type, the
 * overlay's most central persons, and its detected communities. Every one of
 * those reads a field the preview already returned; nothing is computed here.
 * After a commit they show what was actually written: the confirmed graph totals
 * and the pattern ids the recomputation genuinely newly asserted.
 */
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { api } from '@/api';
import { ApiError } from '@/api/client';
import { NetworkGraph } from '@/components/graph';
import { Badge, Button, Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui';
import { useLive } from '@/hooks/useLive';
import {
  BULK_SOURCE_TYPES,
  BULK_STAGES,
  type BulkBatchFileIn,
  type BulkBatchPreviewOut,
  type BulkConfirmOut,
  type BulkFileOut,
  type BulkPreviewOut,
  type BulkRowOut,
  type BulkSourceType,
  type BulkStage,
  type LiveEvent,
  type PatternListResponse,
} from '@/types/api';
import { formatCount, formatMetric } from '@/utils/format';

import { DetectedCommunities, KeyPlayers, PreviewPatterns } from './PreviewTables';

const SOURCE_LABELS: Record<BulkSourceType, string> = {
  call: 'Call',
  transaction: 'Transaction',
  fir: 'FIR',
  location: 'Location',
};

/** The order the four inputs are offered in. All of them are optional. */
const ALL_TYPES: readonly BulkSourceType[] = ['fir', 'call', 'transaction', 'location'];

const STAGE_LABELS: Record<BulkStage, string> = {
  received: 'Received',
  validating: 'Validating rows',
  checking_duplicates: 'Checking for duplicates',
  building_preview: 'Building preview graph',
  analyzing_preview: 'Analysing preview',
  preview_ready: 'Preview ready',
};

/**
 * What a file's own row says about it, per §17 and §14.
 *
 * The three ways of contributing nothing are three different statuses, because
 * they are three different pieces of news: rows already recorded are skipped, rows
 * whose fields are unusable are rejected, and rows whose person could not be
 * resolved need a decision. Only the first of them is "already in system".
 */
const FILE_STATUS: Record<
  string,
  { label: string; tone: 'ok' | 'muted' | 'warn' | 'alert'; note: string }
> = {
  ok: { label: 'Ready', tone: 'ok', note: '' },
  committed: { label: 'Committed', tone: 'ok', note: '' },
  skipped: { label: 'Skipped', tone: 'muted', note: 'Already in system — skipped.' },
  rejected: { label: 'Rejected', tone: 'alert', note: '' },
  review: { label: 'Needs review', tone: 'warn', note: '' },
  error: { label: 'Error', tone: 'alert', note: '' },
};

type Mode = 'single' | 'all';

type Phase = 'idle' | 'previewing' | 'preview' | 'committing' | 'committed';

type Accent = 'cyan' | 'azure' | 'neutral' | 'ok' | 'warn';

interface Tile {
  label: string;
  value: string;
  accent: Accent;
  footnote?: string;
}

/** The backend's own message, plus the column list it returns on a bad header. */
function errorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    const detail = cause.detail;
    if (detail && typeof detail === 'object') {
      const expected = (detail as { expected_columns?: unknown }).expected_columns;
      if (Array.isArray(expected)) {
        return `${cause.message}. Expected columns: ${expected.join(', ')}`;
      }
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The file's text. `FileReader` rather than `Blob.text()`: it is the one reader
 * every browser and jsdom both implement, so the upload path under test is the
 * upload path that ships.
 */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

/** `CALL` and `call` are the same type; the API returns the first form. */
function sourceLabel(sourceType: string | null | undefined): string {
  const key = String(sourceType ?? '').toLowerCase() as BulkSourceType;
  return SOURCE_LABELS[key] ?? String(sourceType ?? '');
}

/** A file's counts, in words, omitting the zeroes. */
function fileCounts(file: BulkFileOut): string {
  const parts: string[] = [];
  const written = file.imported;
  if (written !== undefined) parts.push(`${formatCount(written)} written`);
  else if (file.counts.new_valid > 0) parts.push(`${formatCount(file.counts.new_valid)} new`);
  if (file.counts.duplicate > 0) parts.push(`${formatCount(file.counts.duplicate)} duplicate`);
  if (file.counts.review_required > 0) {
    parts.push(`${formatCount(file.counts.review_required)} to review`);
  }
  if (file.counts.rejected > 0) parts.push(`${formatCount(file.counts.rejected)} rejected`);
  return `${parts.join(' · ')} of ${formatCount(file.counts.total)}`;
}

/**
 * The note on a file's row.
 *
 * A file that could not be read says why. A file whose rows were all rejected, or
 * all need review, shows the backend's own reason for the first of them — the same
 * sentence that row carries in the list below — never the duplicate wording, which
 * would claim the rows are already recorded when nothing in the file was read.
 */
function fileNote(file: BulkFileOut): string {
  if (file.error) return file.error;
  const note = FILE_STATUS[file.status]?.note;
  if (note) return note;
  const counts = fileCounts(file);
  return file.reason ? `${counts} · ${file.reason}` : counts;
}

export function CsvImport({ onClose }: { onClose: () => void }): ReactElement {
  const [mode, setMode] = useState<Mode>('single');
  const [sourceType, setSourceType] = useState<BulkSourceType>('call');
  const [file, setFile] = useState<File | null>(null);
  const [selection, setSelection] = useState<Partial<Record<BulkSourceType, File>>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkPreviewOut | BulkBatchPreviewOut | null>(null);
  const [committed, setCommitted] = useState<BulkConfirmOut | null>(null);
  const [frames, setFrames] = useState<{ importId: string; stage: string; detail?: string }[]>([]);

  useLive(
    useCallback((event: LiveEvent) => {
      if (event.event_type !== 'bulk_preview') return;
      const { import_id: importId, stage, detail } = event.data;
      if (typeof importId !== 'string' || typeof stage !== 'string') return;
      setFrames((previous) => [
        ...previous,
        { importId, stage, detail: typeof detail === 'string' ? detail : undefined },
      ]);
    }, []),
  );

  /*
   * Frames arrive while the POST is still in flight, so the import id is not
   * known yet: they are grouped by the id the backend sent and resolved against
   * the response once it lands.
   */
  const mine = useMemo(() => {
    const active =
      preview?.import_id ??
      (frames.length > 0 ? frames[frames.length - 1].importId : null);
    return frames.filter((frame) => frame.importId === active);
  }, [frames, preview]);
  const reached = useMemo(() => new Set(mine.map((frame) => frame.stage)), [mine]);
  const stageDetail = mine.find((frame) => frame.detail)?.detail;

  /** A combined preview carries the per-file breakdown; a single-type one does not. */
  const batch = preview && 'files' in preview ? preview : null;
  const chosen = ALL_TYPES.filter((type) => selection[type] !== undefined);

  const reset = () => {
    setError(null);
    setPreview(null);
    setCommitted(null);
    setFrames([]);
  };

  /* Switching mode abandons an uncommitted preview, exactly as closing the modal
     does: nothing was written, and the backend expires what it still holds. */
  const changeMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setPhase('idle');
    reset();
  };

  const upload = async () => {
    if (!file) return;
    reset();
    setPhase('previewing');
    try {
      const content = await readText(file);
      const result = await api.previewBulkCsv(sourceType, { filename: file.name, content });
      setPreview(result);
      setPhase('preview');
    } catch (cause) {
      setError(errorText(cause));
      setPhase('idle');
    }
  };

  const uploadAll = async () => {
    if (chosen.length === 0) return;
    reset();
    setPhase('previewing');
    try {
      const files: BulkBatchFileIn[] = [];
      for (const type of chosen) {
        const picked = selection[type] as File;
        files.push({
          source_type: type,
          filename: picked.name,
          content: await readText(picked),
        });
      }
      setPreview(await api.previewBulkBatch({ files }));
      setPhase('preview');
    } catch (cause) {
      setError(errorText(cause));
      setPhase('idle');
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setError(null);
    setPhase('committing');
    try {
      setCommitted(await api.confirmBulkImport(preview.import_id));
      setPhase('committed');
    } catch (cause) {
      setError(errorText(cause));
      setPhase('preview');
    }
  };

  /*
   * Reject discards the held preview. A combined import answers to the batch id
   * and to each file's own id, so every id it gave out is rejected: the first
   * call drops it and the rest report nothing left to drop, which is not an
   * error.
   */
  const reject = async () => {
    if (!preview) {
      onClose();
      return;
    }
    const ids = batch ? batch.import_ids : [preview.import_id];
    try {
      for (const id of ids) {
        await api.rejectBulkImport(id);
      }
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const counts = preview?.counts;
  const metrics = preview?.metrics_preview;
  const graphBefore = committed?.graph_before ?? batch?.graph_before ?? null;
  /* After a commit the breakdown is what each file actually wrote. */
  const fileRows: BulkFileOut[] | null = committed?.files ?? batch?.files ?? null;

  const tiles: Tile[] = useMemo(() => {
    if (!counts || !metrics) return [];
    const nodes = committed ? committed.graph_totals.nodes : metrics.graph?.node_count;
    const edges = committed ? committed.graph_totals.edges : metrics.graph?.edge_count;
    const list: Tile[] = [
      {
        label: batch ? 'Rows in files' : 'Rows in file',
        value: formatCount(counts.total),
        accent: 'neutral',
      },
      {
        label: committed ? 'Committed' : 'New',
        value: formatCount(committed ? committed.counts.imported : counts.new_valid),
        accent: 'cyan',
      },
      { label: 'Duplicates', value: formatCount(counts.duplicate), accent: 'neutral' },
      {
        label: 'Needs review',
        value: formatCount(counts.review_required),
        accent: counts.review_required > 0 ? 'warn' : 'neutral',
      },
      {
        label: 'Rejected',
        value: formatCount(counts.rejected),
        accent: counts.rejected > 0 ? 'warn' : 'neutral',
      },
      {
        label: 'Graph entities',
        value: formatCount(nodes),
        accent: 'cyan',
        footnote:
          graphBefore?.nodes === undefined
            ? undefined
            : `Before ${formatCount(graphBefore.nodes)}`,
      },
      {
        label: 'Graph relationships',
        value: formatCount(edges),
        accent: 'cyan',
        footnote:
          graphBefore?.edges === undefined
            ? undefined
            : `Before ${formatCount(graphBefore.edges)}`,
      },
    ];
    if (committed) {
      list.push({
        label: 'New patterns',
        value: formatCount(committed.new_pattern_ids.length),
        accent: 'azure',
      });
      list.push({
        label: 'Priority changes',
        value: formatCount(committed.priority_changes.length),
        accent: 'azure',
      });
      return list;
    }
    if (metrics.analytics?.persons !== undefined) {
      list.push({
        label: 'Analysed persons',
        value: formatCount(metrics.analytics.persons),
        accent: 'neutral',
      });
    }
    if (metrics.communities?.count !== undefined) {
      list.push({
        label: 'Communities',
        value: formatCount(metrics.communities.count),
        accent: 'azure',
      });
      list.push({
        label: 'Modularity',
        value: formatMetric(metrics.communities.modularity, 3),
        accent: 'azure',
      });
    }
    return list;
  }, [counts, metrics, committed, batch, graphBefore]);

  /* After a commit, only the patterns the recomputation actually asserted. */
  const patterns: PatternListResponse | null = useMemo(() => {
    const list = preview?.suspicious_patterns_preview;
    if (!list) return null;
    if (!committed) return list;
    const asserted = new Set(committed.new_pattern_ids);
    const rows = list.patterns.filter((pattern) => asserted.has(pattern.pattern_id));
    return {
      ...list,
      patterns: rows,
      total: rows.length,
      count: rows.length,
      filters: { scope: 'committed' },
      note: 'Patterns the detectors newly asserted when this import was committed.',
    };
  }, [preview, committed]);

  const busy = phase === 'previewing' || phase === 'committing';
  const showStages = phase !== 'idle';

  return (
    <div className="border-line bg-panel rounded-b-md border" data-testid="csv-import">
      <div className="space-y-4 px-4 py-4">
        {/* --- one file of one type, or several of different types ------ */}
        <div className="tab-bar" role="tablist" aria-label="Import mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            onClick={() => changeMode('single')}
            disabled={busy}
            className="tab-item"
            data-testid="csv-mode-single"
          >
            Single Type
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'all'}
            onClick={() => changeMode('all')}
            disabled={busy}
            className="tab-item"
            data-testid="csv-mode-all"
          >
            All Types
          </button>
        </div>

        {mode === 'single' ? (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <label className="block">
              <span className="field-label">Record type</span>
              <select
                value={sourceType}
                onChange={(event) => setSourceType(event.target.value as BulkSourceType)}
                disabled={busy}
                data-testid="csv-source-type"
                className="border-line bg-inset text-ink focus:border-line-accent mt-1 w-full rounded-sm border px-2 py-1.5 text-xs outline-none"
              >
                {BULK_SOURCE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {SOURCE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="field-label">CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError(null);
                }}
                data-testid="csv-file"
                className="border-line bg-inset text-ink-2 file:border-line-strong file:bg-panel-2 file:text-ink-2 mt-1 w-full cursor-pointer rounded-sm border px-2 py-1.5 text-xs outline-none file:mr-2 file:rounded-xs file:border file:px-2 file:py-0.5 file:text-2xs file:font-semibold"
              />
            </label>

            <Button
              variant="primary"
              onClick={upload}
              disabled={!file || busy}
              loading={phase === 'previewing'}
              data-testid="csv-upload"
            >
              Upload
            </Button>
          </div>
        ) : (
          <div className="max-w-2xl space-y-2" data-testid="csv-files">
            <p className="text-ink-4 text-2xs leading-snug">
              Choose one to four files. They are analysed together, so a
              relationship that spans two of them is visible before anything is
              added.
            </p>
            {ALL_TYPES.map((type) => (
              <label
                key={type}
                className="grid items-center gap-2 sm:grid-cols-[7rem_1fr]"
              >
                <span className="field-label">{SOURCE_LABELS[type]}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={busy}
                  onChange={(event) => {
                    const picked = event.target.files?.[0];
                    setSelection((previous) => {
                      const next = { ...previous };
                      if (picked) next[type] = picked;
                      else delete next[type];
                      return next;
                    });
                    setError(null);
                  }}
                  data-testid={`csv-file-${type}`}
                  className="border-line bg-inset text-ink-2 file:border-line-strong file:bg-panel-2 file:text-ink-2 w-full cursor-pointer rounded-sm border px-2 py-1.5 text-xs outline-none file:mr-2 file:rounded-xs file:border file:px-2 file:py-0.5 file:text-2xs file:font-semibold"
                />
              </label>
            ))}
            <Button
              variant="primary"
              onClick={uploadAll}
              disabled={chosen.length === 0 || busy}
              loading={phase === 'previewing'}
              data-testid="csv-upload-all"
            >
              Upload All
            </Button>
          </div>
        )}

        {error ? (
          <p
            className="border-alert-500/45 bg-alert-500/10 text-alert-300 rounded-sm border px-2.5 py-2 text-xs"
            data-testid="csv-error"
          >
            {error}
          </p>
        ) : null}

        {showStages ? <Stages reached={reached} detail={stageDetail} /> : null}

        {/* --- what committing would do -------------------------------- */}
        {preview && counts ? (
          <div className="space-y-4" data-testid="csv-preview">
            <div className="flex items-center gap-2">
              <h3 className="text-ink text-sm font-semibold">
                {committed
                  ? 'Committed'
                  : batch
                    ? `If these ${formatCount(batch.files.length)} files are added`
                    : 'If this file is added'}
              </h3>
              {committed ? (
                <span data-testid="live-badge">
                  <Badge tone="ok">Live</Badge>
                </span>
              ) : (
                <span data-testid="preview-badge">
                  <Badge tone="warn">Preview</Badge>
                </span>
              )}
              <Badge tone="muted">Synthetic data only</Badge>
            </div>

            {fileRows ? <FileSummary files={fileRows} /> : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
              {tiles.map((tile) => (
                <StatTile
                  key={tile.label}
                  label={tile.label}
                  value={tile.value}
                  footnote={tile.footnote}
                  accent={tile.accent}
                />
              ))}
            </div>

            {metrics?.note ? (
              <p className="text-ink-4 text-2xs" data-testid="csv-metrics-note">
                {metrics.note}
              </p>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
              <Panel className="flex min-w-0 flex-col">
                <PanelHeader
                  title="Affected network"
                  subtitle={`${formatCount(preview.network_preview.nodes.length)} entities · ${formatCount(preview.network_preview.edges.length)} relationships`}
                  accent
                />
                <PanelBody padded={false} className="min-h-0 flex-1">
                  <NetworkGraph
                    nodes={preview.network_preview.nodes}
                    edges={preview.network_preview.edges}
                  />
                </PanelBody>
              </Panel>

              <KeyPlayers players={metrics?.key_players ?? []} />
            </div>

            {patterns ? (
              <PreviewPatterns
                title={committed ? 'New patterns' : 'Patterns this would add'}
                patterns={patterns.patterns}
                note={patterns.note}
              />
            ) : null}

            <DetectedCommunities
              communities={metrics?.communities?.detected ?? []}
              modularity={metrics?.communities?.modularity}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <RowList
                title="Already in system"
                note="Skipped — nothing is written twice."
                rows={preview.duplicate_rows}
                tone="muted"
                testId="csv-duplicate-rows"
              />
              <RowList
                title="Needs review"
                note="Not committed: the reference could not be resolved to one existing person."
                rows={preview.review_required_rows}
                tone="warn"
                testId="csv-review-rows"
              />
              <RowList
                title="Rejected"
                note="Not committed: a field value is unusable."
                rows={preview.rejected_rows}
                tone="alert"
                testId="csv-rejected-rows"
              />
            </div>

            {committed && committed.skipped.length > 0 ? (
              <p className="text-warn-300 text-2xs" data-testid="csv-skipped">
                {formatCount(committed.skipped.length)} row(s) stopped being committable
                between the preview and the commit and were not written.
              </p>
            ) : null}
            {committed?.recompute_error ? (
              <p className="text-alert-300 text-2xs">{committed.recompute_error}</p>
            ) : null}
            {committed?.audit_error ? (
              <p className="text-alert-300 text-2xs">{committed.audit_error}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* --- decide ---------------------------------------------------- */}
      {preview && counts ? (
        <div className="border-line bg-panel-2 flex flex-wrap items-center justify-between gap-3 rounded-b-md border-t px-4 py-2.5">
          <p className="text-ink-4 min-w-0 text-2xs leading-snug">{preview.disclaimer}</p>
          <div className="flex shrink-0 items-center gap-2">
            {committed ? (
              <>
                <span className="text-ok-300 text-xs font-semibold" data-testid="csv-committed">
                  Added to the system
                </span>
                <Button variant="secondary" onClick={onClose} data-testid="csv-close">
                  Close
                </Button>
              </>
            ) : (
              <>
                {preview.commit_applicable ? (
                  <Button
                    variant="primary"
                    onClick={confirm}
                    loading={phase === 'committing'}
                    data-testid="csv-confirm"
                  >
                    {batch ? 'Add All to System' : 'Add to System'}
                  </Button>
                ) : (
                  <span className="text-ink-3 text-xs" data-testid="csv-nothing-new">
                    {counts.duplicate === counts.total
                      ? 'Nothing new — all duplicates'
                      : 'Nothing new to add'}
                  </span>
                )}
                <Button
                  variant="secondary"
                  onClick={reject}
                  disabled={phase === 'committing'}
                  data-testid="csv-reject"
                >
                  {batch ? 'Reject All' : 'Reject'}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- stages -- */

function Stages({ reached, detail }: { reached: Set<string>; detail?: string }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <ol className="flex flex-wrap gap-x-4 gap-y-1.5" data-testid="csv-stages">
        {BULK_STAGES.map((stage) => {
          const done = reached.has(stage);
          return (
            <li
              key={stage}
              data-testid={`csv-stage-${stage}`}
              data-done={done ? 'true' : 'false'}
              className={done ? 'text-ok-300 flex items-center gap-1.5 text-2xs' : 'text-ink-4 flex items-center gap-1.5 text-2xs'}
            >
              <span aria-hidden="true" className="font-mono">
                {done ? '✓' : '·'}
              </span>
              {STAGE_LABELS[stage]}
            </li>
          );
        })}
      </ol>
      {detail ? (
        <span className="text-ink-4 text-2xs" data-testid="csv-stage-detail">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- per-file summary -- */

/**
 * One row per selected file: what it carried, and what became of it. A file the
 * parser could not read says why and does not stop the others. A file that added
 * nothing says which of the three reasons applies — already recorded, nothing
 * usable, or nothing resolvable — and, for the last two, the reason itself.
 */
function FileSummary({ files }: { files: BulkFileOut[] }): ReactElement {
  return (
    <ul className="space-y-1" data-testid="csv-file-summary">
      {files.map((file) => {
        const status = FILE_STATUS[file.status] ?? { label: file.status, tone: 'muted' as const };
        return (
          <li
            key={`${file.index}-${file.filename}`}
            data-testid="csv-file-row"
            data-status={file.status}
            className="border-line bg-inset flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-2.5 py-1.5"
          >
            <Badge tone="neutral">{sourceLabel(file.source_type)}</Badge>
            <span className="text-ink-2 truncate font-mono text-2xs">{file.filename}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="text-ink-3 min-w-0 text-2xs leading-snug">{fileNote(file)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------- row lists -- */

function RowList({
  title,
  note,
  rows,
  tone,
  testId,
}: {
  title: string;
  note: string;
  rows: BulkRowOut[];
  tone: 'muted' | 'warn' | 'alert';
  testId: string;
}): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline gap-2">
        <h4 className="field-label">{title}</h4>
        <Badge tone={tone}>{formatCount(rows.length)}</Badge>
      </div>
      <p className="text-ink-4 mt-0.5 text-2xs leading-snug">{note}</p>
      <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
        {rows.map((row, index) => (
          <li
            // Row numbers restart in every file of a combined import, so the
            // position in this list is what makes the key unique.
            key={`${row.source_type ?? ''}-${row.row}-${index}`}
            data-testid="csv-row"
            className="border-line bg-inset rounded-sm border px-2 py-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink-2 text-2xs font-semibold">
                {row.source_type ? `${sourceLabel(row.source_type)} row ${row.row}` : `Row ${row.row}`}
              </span>
              <span className="text-ink-4 truncate font-mono text-2xs">{row.summary}</span>
            </div>
            <p className="text-ink-3 mt-0.5 text-2xs leading-snug">{row.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
