/**
 * The live surface: a CSV judged before any of it is written, and the connection
 * state of the channel that reports the judging.
 *
 * Every fixture below is a recording. The bulk-import ones were captured by
 * `backend/scripts/phase6_2_bulk_demo.py`, which drives one five-row file through
 * the real routes: preview, commit, the same rows uploaded again, and a rejected
 * preview. That matters more here than anywhere else in this suite, because the
 * whole claim of the feature is that the numbers on screen are the backend's
 * numbers — a hand-written "2 new rows" body would test nothing.
 *
 * What these cases hold in place:
 *
 *  1. THE CLIENT DECIDES NOTHING. It posts the file and renders the verdicts that
 *     came back. Duplicates are listed as skipped, never as a question.
 *  2. NOTHING IS WRITTEN BY LOOKING. A preview renders in full and no commit
 *     request is made until the operator asks for one.
 *  3. A CHECKMARK MEANS A FINISHED STEP. The six stages tick only as `bulk_preview`
 *     frames arrive; a preview that returned without frames shows none of them
 *     ticked, which is what makes "no client-side timer" testable.
 *  4. NOTHING IS CLAIMED AFTER A COMMIT THAT THE RECOMPUTATION DID NOT ASSERT.
 *     The committed view keeps only the pattern ids the confirm response names.
 *  5. THE STREAM IS NAMED FRAMES. The backend names every frame, so the client
 *     must listen per type; the stub delivers named frames only.
 *  6. LIVE MEANS NO RELOAD. One accepted record refreshes the queue in place,
 *     once — and a frame that cannot have moved a score does not refetch at all.
 *  7. SEVERAL FILES ARE ONE IMPORT. All Types mode posts the whole selection to
 *     the combined route once, commits it once and rejects every id it was given;
 *     the recorded preview contains a relationship that spans two of the files,
 *     which is what separates a combined analysis from merged per-file results.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LIVE_EVENT_TYPES } from '@/types/api';
import {
  fixtures,
  installEventSource,
  installFetch,
  liveEvent,
  renderWithRouter,
  statTile,
} from '@/test/helpers';
import { AlertsPage } from '@/pages/AlertsPage';
import { formatCount, formatInr, formatMetric } from '@/utils/format';

import { CsvImport } from './CsvImport';
import { UploadCsvButton } from './UploadCsvButton';
import { LiveIndicator } from './LiveIndicator';

const preview = fixtures.bulkPreviewCall;
const committed = fixtures.bulkConfirmCall;
const allDuplicates = fixtures.bulkPreviewDuplicates;
/** The six frames that preview really published, in the order it published them. */
const stageFrames = fixtures.bulkPreviewEvents as Array<{
  event_type: string;
  data: { import_id: string; stage: string };
}>;

/* Phase 6.2b — the same flow with three files chosen at once. */
const batchPreview = fixtures.bulkPreviewBatch;
const batchCommitted = fixtures.bulkConfirmBatch;
const batchDuplicates = fixtures.bulkPreviewBatchDuplicates;
/**
 * The same combined route, fed files exported with the corpus's own column names.
 * Three files, three different reasons for adding nothing new: one that imports,
 * one whose every row is unusable, and one whose header names no person at all.
 * None of them is "already in the system", which is what this recording is for.
 */
const batchNative = fixtures.bulkPreviewBatchNative;
const batchFrames = fixtures.bulkPreviewBatchEvents as Array<{
  event_type: string;
  data: { import_id: string; stage: string; detail?: string };
}>;

const CSV = 'caller_person_id,callee_person_id,start_time,duration_sec\n301,302,2026-08-25T09:05:00,214\n';
const CALL_CSV = 'caller_person_id,callee_person_id,start_time,duration_sec\n411,412,2026-08-26T10:05:00,168\n';
const TXN_CSV =
  'sender_person_id,receiver_person_id,amount_inr,txn_time,mode,bank_ref\n411,412,48000,2026-08-26T11:02:00,UPI,REF-48000-411\n';
const LOCATION_CSV = 'person_person_id,location_id,observed_at\n411,178,2026-08-26T12:00:00\n';
const FIR_CSV = 'complainant_person_id,accused_person_id,date,location_id\n411,412,2026-08-26,178\n';
/* The corpus's own spelling of a party: `caller_id`, `sender_id`. A file exported
 * from the dataset has to import as itself. */
const NATIVE_CALL_CSV =
  'caller_id,callee_id,start_time,duration_sec,cell_tower_id\n421,422,2026-08-27T09:14:00,233,41\n';
const UNUSABLE_TXN_CSV =
  'sender_id,receiver_id,amount_inr,txn_time,mode,bank_ref\n421,422,0,2026-08-27T10:02:00,UPI,REF-A\n';
const PLACES_CSV =
  'location_id,state,city,latitude,longitude\n1,Delhi,New Delhi,8.725312,75.97585\n';

/** Choose a file the way an operator would, then upload it. */
function upload(content = CSV, name = 'calls-batch.csv') {
  const file = new File([content], name, { type: 'text/csv' });
  fireEvent.change(screen.getByTestId('csv-file'), { target: { files: [file] } });
  fireEvent.click(screen.getByTestId('csv-upload'));
}

/** Choose one file for one of the four inputs of All Types mode. */
function choose(type: string, content: string, name: string) {
  const file = new File([content], name, { type: 'text/csv' });
  fireEvent.change(screen.getByTestId(`csv-file-${type}`), { target: { files: [file] } });
}

/** The whole All Types gesture: switch mode, pick files, upload them together. */
function uploadAll(picks: Array<[string, string, string]>) {
  fireEvent.click(screen.getByTestId('csv-mode-all'));
  for (const [type, content, name] of picks) choose(type, content, name);
  fireEvent.click(screen.getByTestId('csv-upload-all'));
}

/** The two good files of the recording, as an operator would select them. */
const TWO_FILES: Array<[string, string, string]> = [
  ['call', CALL_CSV, 'calls-aug26.csv'],
  ['transaction', TXN_CSV, 'transfers-aug26.csv'],
];

const ticked = (
  frames: Array<{ data: { stage: string } }> = stageFrames,
) =>
  frames
    .map((frame) => frame.data.stage)
    .filter((stage) => screen.getByTestId(`csv-stage-${stage}`).dataset.done === 'true');

/** What the component actually sent, parsed. */
function sentBody(fetchMock: { mock: { calls: unknown[][] } }, index = 0) {
  const [, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('CsvImport — a file is judged before any of it is written', () => {
  it('posts the file to the preview route, and commits nothing on its own', async () => {
    const { fetchMock, calls } = installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    upload();
    await waitFor(() => expect(screen.getByTestId('csv-preview')).toBeInTheDocument());

    expect(calls).toContain('/api/v1/ingest/bulk/call/preview');
    // The stub's declared signature takes the URL alone; the init object is the
    // second argument `fetch` was really called with.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    // The file is sent as it was read: no client-side parsing, filtering or
    // reformatting, because the backend owns every judgement about it.
    expect(JSON.parse(String(init.body))).toEqual({
      filename: 'calls-batch.csv',
      content: CSV,
    });

    // A full preview is on screen and nothing has been committed to produce it.
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
    expect(screen.getByTestId('preview-badge')).toBeInTheDocument();
  });

  it('ticks a stage only when the backend reports that stage', async () => {
    installFetch();
    const sse = installEventSource();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    upload();
    await waitFor(() => expect(screen.getByTestId('csv-stages')).toBeInTheDocument());

    // The preview has answered in full, and not one checkmark has been assumed.
    await waitFor(() => expect(screen.getByTestId('csv-preview')).toBeInTheDocument());
    expect(ticked()).toEqual([]);

    // Each frame ticks its own stage, in the order the backend reached them.
    const seen: string[] = [];
    for (const frame of stageFrames) {
      sse.push(frame);
      seen.push(frame.data.stage);
      expect(ticked()).toEqual(seen);
    }
    expect(seen).toEqual([
      'received',
      'validating',
      'checking_duplicates',
      'building_preview',
      'analyzing_preview',
      'preview_ready',
    ]);
  });

  it('shows what committing the file would do, marked as a preview', async () => {
    installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    upload();
    const panel = await screen.findByTestId('csv-preview');

    // Every row is accounted for, as the backend classified it.
    expect(within(statTile('Rows in file')).getByText(formatCount(preview.counts.total))).toBeInTheDocument();
    expect(within(statTile('New')).getByText(formatCount(preview.counts.new_valid))).toBeInTheDocument();
    expect(within(statTile('Duplicates')).getByText(formatCount(preview.counts.duplicate))).toBeInTheDocument();
    expect(within(statTile('Needs review')).getByText(formatCount(preview.counts.review_required))).toBeInTheDocument();
    expect(within(statTile('Rejected')).getByText(formatCount(preview.counts.rejected))).toBeInTheDocument();

    // The graph totals are the overlay's, i.e. what the graph *would* hold.
    expect(
      within(statTile('Graph entities')).getByText(
        formatCount(preview.metrics_preview.graph.node_count),
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('network-graph')).toBeInTheDocument();

    // The patterns come from the preview response itself — the overlay they were
    // detected on exists nowhere else, so there is nothing to refetch. Grouped by
    // type, the tab counts still add up to every pattern in the response.
    const patterns = preview.suspicious_patterns_preview.patterns;
    const tabs = within(screen.getByTestId('preview-patterns')).getAllByRole('tab');
    expect(tabs.reduce((total, tab) => total + Number(tab.dataset.count), 0)).toBe(
      patterns.length,
    );
    expect(screen.getAllByTestId('preview-pattern-row')).toHaveLength(1);
    expect(screen.getByText(patterns[0].entity_ids[0])).toBeInTheDocument();

    // Duplicates are stated as skipped, not offered as a decision.
    const duplicates = screen.getByTestId('csv-duplicate-rows');
    expect(within(duplicates).getAllByTestId('csv-row')).toHaveLength(preview.duplicate_rows.length);
    expect(within(duplicates).getByText(/Skipped/)).toBeInTheDocument();
    expect(within(duplicates).getByText(preview.duplicate_rows[0].reason)).toBeInTheDocument();

    // Held and rejected rows carry the backend's reason for each.
    expect(
      within(screen.getByTestId('csv-review-rows')).getByText(preview.review_required_rows[0].reason),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('csv-rejected-rows')).getByText(preview.rejected_rows[0].reason),
    ).toBeInTheDocument();

    const rendered = panel.textContent ?? '';
    for (const word of ['criminal', 'guilty', 'demo', 'prototype']) {
      expect(rendered.toLowerCase()).not.toContain(word);
    }
  });

  it('commits on the operator’s decision, and then reports what was written', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    upload();
    fireEvent.click(await screen.findByTestId('csv-confirm'));
    await waitFor(() => expect(screen.getByTestId('csv-committed')).toBeInTheDocument());

    expect(calls.some((url) => url.endsWith(`/${preview.import_id}/confirm`))).toBe(true);
    // Committed is not a preview, and cannot be committed twice.
    expect(screen.queryByTestId('preview-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('csv-confirm')).not.toBeInTheDocument();

    expect(within(statTile('Committed')).getByText(formatCount(committed.counts.imported))).toBeInTheDocument();
    // The committed graph is the graph the preview described.
    expect(committed.graph_totals.edges).toBe(preview.metrics_preview.graph.edge_count);
    expect(
      within(statTile('Graph relationships')).getByText(formatCount(committed.graph_totals.edges)),
    ).toBeInTheDocument();
    expect(
      within(statTile('Graph entities')).getByText(formatCount(committed.graph_totals.nodes)),
    ).toBeInTheDocument();
    expect(
      within(statTile('New patterns')).getByText(formatCount(committed.new_pattern_ids.length)),
    ).toBeInTheDocument();

    // What is still listed as a pattern is a pattern the recomputation asserted.
    const tabs = within(screen.getByTestId('preview-patterns')).getAllByRole('tab');
    expect(tabs.reduce((total, tab) => total + Number(tab.dataset.count), 0)).toBe(
      committed.new_pattern_ids.length,
    );
    expect(committed.new_pattern_ids).toContain(
      preview.suspicious_patterns_preview.patterns[0].pattern_id,
    );
  });

  it('has nothing to add when every row is already in the system', async () => {
    const { calls } = installFetch([
      { match: '/api/v1/ingest/bulk/call/preview', body: allDuplicates },
    ]);
    renderWithRouter(<CsvImport onClose={() => {}} />);

    upload();
    await screen.findByTestId('csv-preview');

    expect(allDuplicates.counts.new_valid).toBe(0);
    expect(screen.queryByTestId('csv-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('csv-nothing-new')).toHaveTextContent('Nothing new — all duplicates');
    expect(
      within(screen.getByTestId('csv-duplicate-rows')).getAllByTestId('csv-row'),
    ).toHaveLength(allDuplicates.counts.duplicate);

    // Nothing was analysed, so nothing is claimed: no pattern row on any tab, the
    // group's own empty state, and the backend's explanation of why there are none.
    const grouped = within(screen.getByTestId('preview-patterns'));
    expect(screen.queryByTestId('preview-pattern-row')).not.toBeInTheDocument();
    expect(grouped.getAllByRole('tab').map((tab) => tab.dataset.count)).not.toContain('1');
    expect(grouped.getByTestId('empty-state')).toHaveTextContent('None in this preview');
    expect(screen.getByTestId('csv-metrics-note')).toHaveTextContent(
      String(allDuplicates.metrics_preview.note),
    );
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
  });

  it('writes nothing when the preview is rejected', async () => {
    const { calls } = installFetch();
    const closed = vi.fn();
    renderWithRouter(<CsvImport onClose={closed} />);

    upload();
    fireEvent.click(await screen.findByTestId('csv-reject'));

    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(calls.some((url) => url.endsWith(`/${preview.import_id}/reject`))).toBe(true);
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
  });
});

describe('CsvImport — All Types: several files judged as one import', () => {
  it('sends the whole selection to the combined route in one request', async () => {
    const { fetchMock, calls } = installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    // Nothing is required, so there is nothing to upload until something is picked.
    fireEvent.click(screen.getByTestId('csv-mode-all'));
    expect(screen.getByTestId('csv-upload-all')).toBeDisabled();

    uploadAll(TWO_FILES);
    await waitFor(() => expect(screen.getByTestId('csv-preview')).toBeInTheDocument());

    // ONE request, to the combined route. Per-type previews cannot see across
    // files, so a client that looped over the single-type route would be wrong
    // however tidy the merged display looked.
    const previews = calls.filter((url) => url.includes('/preview'));
    expect(previews).toEqual(['/api/v1/ingest/bulk/preview']);
    expect(sentBody(fetchMock)).toEqual({
      files: [
        { source_type: 'call', filename: 'calls-aug26.csv', content: CALL_CSV },
        { source_type: 'transaction', filename: 'transfers-aug26.csv', content: TXN_CSV },
      ],
    });
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
  });

  it('carries all four record types in one selection', async () => {
    const { fetchMock } = installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll([
      ['fir', FIR_CSV, 'firs.csv'],
      ['call', CALL_CSV, 'calls.csv'],
      ['transaction', TXN_CSV, 'transfers.csv'],
      ['location', LOCATION_CSV, 'sightings.csv'],
    ]);
    await waitFor(() => expect(screen.getByTestId('csv-preview')).toBeInTheDocument());

    // The request is what this case is about; the stub answers with the recorded
    // three-file preview, which the cases below assert against.
    const body = sentBody(fetchMock) as { files: Array<{ source_type: string }> };
    expect(body.files.map((file) => file.source_type)).toEqual([
      'fir',
      'call',
      'transaction',
      'location',
    ]);
  });

  it('reports each file, and totals that cover all of them', async () => {
    installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll(TWO_FILES);
    await screen.findByTestId('csv-preview');

    // One row per file, saying what it was and what became of it. The file the
    // parser could not read is reported on its own row, with the backend's reason,
    // and did not stop the other two from being previewed.
    const rows = within(screen.getByTestId('csv-file-summary')).getAllByTestId('csv-file-row');
    expect(rows).toHaveLength(batchPreview.files.length);
    expect(rows.map((row) => row.dataset.status)).toEqual(['ok', 'ok', 'error']);
    for (const [index, file] of batchPreview.files.entries()) {
      expect(within(rows[index]).getByText(file.filename)).toBeInTheDocument();
    }
    expect(within(rows[2]).getByText(String(batchPreview.files[2].error))).toBeInTheDocument();

    // The totals are the combined ones: three rows across the selection, not one
    // file's three rows.
    expect(batchPreview.counts.total).toBe(
      batchPreview.files.reduce((sum, file) => sum + file.counts.total, 0),
    );
    expect(
      within(statTile('Rows in files')).getByText(formatCount(batchPreview.counts.total)),
    ).toBeInTheDocument();
    expect(
      within(statTile('New')).getByText(formatCount(batchPreview.counts.new_valid)),
    ).toBeInTheDocument();
    expect(
      within(statTile('Rejected')).getByText(formatCount(batchPreview.counts.rejected)),
    ).toBeInTheDocument();

    // Graph impact reads before → preview, from the backend's own two numbers.
    const relationships = statTile('Graph relationships');
    expect(
      within(relationships).getByText(formatCount(batchPreview.metrics_preview.graph.edge_count)),
    ).toBeInTheDocument();
    expect(
      within(relationships).getByText(`Before ${formatCount(batchPreview.graph_before.edges)}`),
    ).toBeInTheDocument();
    expect(batchPreview.graph_before.edges).toBeLessThan(
      batchPreview.metrics_preview.graph.edge_count,
    );

    // A rejected row names the file it came from: row numbers restart per file.
    const rejected = screen.getByTestId('csv-rejected-rows');
    expect(within(rejected).getByText(/^Call row \d+$/)).toBeInTheDocument();
    expect(screen.getByTestId('preview-badge')).toBeInTheDocument();
  });

  it('shows the relationship that only exists across two of the files', async () => {
    installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll(TWO_FILES);
    await screen.findByTestId('csv-preview');

    // Persons 411 and 412 speak in the call file and move money in the transaction
    // file. One channel is not a multi-channel relationship, so this detection
    // exists only because both files were analysed on one overlay — it is the
    // observable difference between a combined preview and two merged ones.
    const crossFile = batchPreview.suspicious_patterns_preview.patterns.filter(
      (pattern) => pattern.pattern_type === 'MULTI_CHANNEL_RELATIONSHIP',
    );
    expect(crossFile).toHaveLength(1);
    expect(crossFile[0].entity_ids).toEqual(['person:411', 'person:412']);
    expect(crossFile[0].detail.channels).toEqual(['CALL', 'TRANSACTION']);

    // Grouped by type, every pattern of the response is still accounted for, and
    // the pair is the one row on the multi-channel tab.
    const tabs = within(screen.getByTestId('preview-patterns')).getAllByRole('tab');
    expect(tabs.reduce((total, tab) => total + Number(tab.dataset.count), 0)).toBe(
      batchPreview.suspicious_patterns_preview.patterns.length,
    );
    fireEvent.click(screen.getByTestId('preview-tab-multi'));
    const shown = screen.getAllByTestId('preview-pattern-row');
    expect(shown).toHaveLength(1);
    for (const entityId of crossFile[0].entity_ids) {
      expect(within(shown[0]).getByText(entityId)).toBeInTheDocument();
    }

    // Each pattern is listed once. The backend deduplicates by its own
    // deterministic pattern id; the client must not re-add or re-count them.
    const ids = batchPreview.suspicious_patterns_preview.patterns.map((p) => p.pattern_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ticks one stage sequence for the whole selection', async () => {
    installFetch();
    const sse = installEventSource();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll(TWO_FILES);
    await screen.findByTestId('csv-preview');
    expect(ticked(batchFrames)).toEqual([]);

    // Six frames for three files, not six per file, and the running sub-label is
    // the backend's own count.
    for (const frame of batchFrames) sse.push(frame);
    expect(ticked(batchFrames)).toEqual([
      'received',
      'validating',
      'checking_duplicates',
      'building_preview',
      'analyzing_preview',
      'preview_ready',
    ]);
    expect(batchFrames).toHaveLength(6);
    expect(screen.getAllByTestId('csv-stages')).toHaveLength(1);
    expect(screen.getByTestId('csv-stage-detail')).toHaveTextContent('3 file(s)');
  });

  it('adds the whole selection with one commit, then reports what was written', async () => {
    const { calls } = installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll(TWO_FILES);
    const button = await screen.findByTestId('csv-confirm');
    expect(button).toHaveTextContent('Add All to System');
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('csv-committed')).toBeInTheDocument());

    // ONE confirm for the batch — not one per file. The backend recomputes once and
    // writes one audit event behind this single call.
    const confirms = calls.filter((url) => url.includes('/confirm'));
    expect(confirms).toEqual([`/api/v1/ingest/bulk/${batchPreview.import_id}/confirm`]);
    expect(batchPreview.import_ids).toHaveLength(3);
    expect(batchCommitted.audit_event_id).toBeTruthy();

    // Preview is over: this is now live, and cannot be committed again.
    expect(screen.getByTestId('live-badge')).toHaveTextContent('Live');
    expect(screen.queryByTestId('preview-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('csv-confirm')).not.toBeInTheDocument();

    expect(
      within(statTile('Committed')).getByText(formatCount(batchCommitted.counts.imported)),
    ).toBeInTheDocument();
    expect(
      within(statTile('Graph relationships')).getByText(
        formatCount(batchCommitted.graph_totals.edges),
      ),
    ).toBeInTheDocument();
    expect(
      within(statTile('Graph relationships')).getByText(
        `Before ${formatCount(batchCommitted.graph_before.edges)}`,
      ),
    ).toBeInTheDocument();

    // Per file: what it actually wrote, the unreadable one still reported as such.
    const rows = within(screen.getByTestId('csv-file-summary')).getAllByTestId('csv-file-row');
    expect(rows.map((row) => row.dataset.status)).toEqual(['committed', 'committed', 'error']);
    expect(within(rows[0]).getByText(/^1 written/)).toBeInTheDocument();
    expect(
      batchCommitted.files.reduce((sum, file) => sum + (file.imported ?? 0), 0),
    ).toBe(batchCommitted.counts.imported);
  });

  it('has nothing to add when every file is already in the system', async () => {
    const { calls } = installFetch([
      { match: '/api/v1/ingest/bulk/preview', body: batchDuplicates },
    ]);
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll(TWO_FILES);
    await screen.findByTestId('csv-preview');

    expect(batchDuplicates.counts.new_valid).toBe(0);
    expect(screen.queryByTestId('csv-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('csv-nothing-new')).toHaveTextContent('Nothing new — all duplicates');

    // Still a full summary: each file is accounted for as skipped, not failed.
    const rows = within(screen.getByTestId('csv-file-summary')).getAllByTestId('csv-file-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.dataset.status).toBe('skipped');
      expect(within(row).getByText('Already in system — skipped.')).toBeInTheDocument();
    }
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
  });

  it('says why a file added nothing, and only calls it a duplicate when it is', async () => {
    const { calls } = installFetch([
      { match: '/api/v1/ingest/bulk/preview', body: batchNative },
    ]);
    renderWithRouter(<CsvImport onClose={() => {}} />);

    uploadAll([
      ['call', NATIVE_CALL_CSV, 'calls.csv'],
      ['transaction', UNUSABLE_TXN_CSV, 'transactions.csv'],
      ['location', PLACES_CSV, 'locations.csv'],
    ]);
    await screen.findByTestId('csv-preview');

    const rows = within(screen.getByTestId('csv-file-summary')).getAllByTestId('csv-file-row');
    expect(rows.map((row) => row.dataset.status)).toEqual(['ok', 'rejected', 'error']);

    // The corpus's own column names are read: the call file has new rows.
    expect(batchNative.files[0].counts.new_valid).toBeGreaterThan(0);
    expect(within(rows[0]).getByText('Ready')).toBeInTheDocument();

    // The file whose every row is unusable says which field failed — the backend's
    // own words for that row — and is not reported as one already accounted for.
    const failed = String(batchNative.files[1].reason);
    expect(failed).toContain('amount_inr');
    expect(within(rows[1]).getByText('Rejected')).toBeInTheDocument();
    expect(within(rows[1]).getByText(new RegExp(failed))).toBeInTheDocument();
    expect(
      within(rows[1]).queryByText('Already in system — skipped.'),
    ).not.toBeInTheDocument();

    // Nowhere on the screen is a duplicate claimed: there are none in this import.
    expect(batchNative.counts.duplicate).toBe(0);
    expect(screen.queryByText('Already in system — skipped.')).not.toBeInTheDocument();

    // A header that cannot name a person is one file-level error, not N rejected rows.
    expect(within(rows[2]).getByText(String(batchNative.files[2].error))).toBeInTheDocument();
    expect(batchNative.files[2].counts.total).toBe(0);
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
  });

  it('rejects every id the combined preview gave out, and commits nothing', async () => {
    const { calls } = installFetch();
    const closed = vi.fn();
    renderWithRouter(<CsvImport onClose={closed} />);

    uploadAll(TWO_FILES);
    const button = await screen.findByTestId('csv-reject');
    expect(button).toHaveTextContent('Reject All');
    fireEvent.click(button);

    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    // The preview answers to the batch id and to each file's own id; all of them
    // are dropped. The first call discards it and the rest report nothing left.
    expect(calls.filter((url) => url.includes('/reject'))).toEqual(
      batchPreview.import_ids.map((id) => `/api/v1/ingest/bulk/${id}/reject`),
    );
    expect(calls.some((url) => url.includes('/confirm'))).toBe(false);
  });

  it('leaves Single Type mode exactly as it was', async () => {
    const { fetchMock, calls } = installFetch();
    renderWithRouter(<CsvImport onClose={() => {}} />);

    // Out to All Types and back again.
    uploadAll(TWO_FILES);
    await screen.findByTestId('csv-preview');
    fireEvent.click(screen.getByTestId('csv-mode-single'));

    // The combined preview is abandoned, unwritten, with the same screen as before.
    expect(screen.queryByTestId('csv-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('csv-files')).not.toBeInTheDocument();
    expect(screen.getByTestId('csv-source-type')).toBeInTheDocument();

    upload();
    await screen.findByTestId('csv-preview');

    // The single-type contract is untouched: same route, same body, same labels.
    expect(calls).toContain('/api/v1/ingest/bulk/call/preview');
    expect(sentBody(fetchMock, calls.length - 1)).toEqual({
      filename: 'calls-batch.csv',
      content: CSV,
    });
    expect(screen.queryByTestId('csv-file-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('csv-confirm')).toHaveTextContent('Add to System');
    expect(screen.getByTestId('csv-reject')).toHaveTextContent('Reject');
    expect(within(statTile('Rows in file')).getByText(formatCount(preview.counts.total))).toBeInTheDocument();
  });
});

/**
 * The preview dashboard's own tables. Everything asserted below is read out of one
 * recording — two persons who call each other and send money both ways, which is
 * one shape several different existing detectors each have something to say about.
 * Nothing here is computed in the browser, so every expected value is taken from
 * the recording itself rather than written out by hand.
 */
const rich = fixtures.bulkPreviewBatchRich;
const richPatterns = rich.suspicious_patterns_preview.patterns;
const richPlayers = rich.metrics_preview.key_players;
const richCommunities = rich.metrics_preview.communities.detected;

/** How many patterns of these types the recording holds. */
const countOf = (...types: string[]) =>
  richPatterns.filter((pattern) => types.includes(pattern.pattern_type)).length;

/** One pattern of a type, and its detector's own `detail` map. */
function detailOf(type: string): Record<string, unknown> {
  const found = richPatterns.find((pattern) => pattern.pattern_type === type);
  if (!found) throw new Error(`the recording carries no ${type}`);
  return found.detail as Record<string, unknown>;
}

const RICH_CALL_CSV =
  'caller_id,callee_id,start_time,duration_sec,cell_tower_id\n461,462,2026-08-28T09:05:00,214,41\n462,461,2026-08-28T09:41:00,96,41\n';
const RICH_TXN_CSV =
  'sender_id,receiver_id,amount_inr,txn_time,mode,bank_ref\n461,462,48000,2026-08-28T10:02:00,UPI,REF-X1\n462,461,47000,2026-08-28T10:44:00,UPI,REF-X2\n';
const RICH_FILES: Array<[string, string, string]> = [
  ['call', RICH_CALL_CSV, 'calls-pair.csv'],
  ['transaction', RICH_TXN_CSV, 'transfers-pair.csv'],
];

/** Preview the recording above, and wait for the dashboard. */
async function previewRich() {
  const installed = installFetch([{ match: '/api/v1/ingest/bulk/preview', body: rich }]);
  renderWithRouter(<CsvImport onClose={() => {}} />);
  uploadAll(RICH_FILES);
  await screen.findByTestId('csv-preview');
  return installed;
}

const tabCount = (key: string) =>
  Number(screen.getByTestId(`preview-tab-${key}`).dataset.count);

describe('CsvImport — the preview dashboard, in tables', () => {
  it('groups the patterns by the detector’s own type, and counts every one', async () => {
    await previewRich();

    // One tab per group of Phase 4 pattern types, each carrying the number of
    // patterns of that group the response holds — and together, all of them.
    expect(tabCount('cycles')).toBe(countOf('TRANSACTION_CYCLE'));
    expect(tabCount('multi')).toBe(countOf('MULTI_CHANNEL_RELATIONSHIP'));
    expect(tabCount('comms')).toBe(countOf('COMMUNICATION_ANOMALY'));
    expect(tabCount('txn')).toBe(
      countOf('TRANSACTION_FAN_IN', 'TRANSACTION_FAN_OUT', 'TRANSACTION_CONCENTRATION'),
    );
    expect(tabCount('location')).toBe(countOf('LOCATION_COHORT', 'SHARED_LOCATION_PAIR'));
    expect(tabCount('bridge')).toBe(countOf('BRIDGE_ENTITY'));

    const tabs = within(screen.getByTestId('preview-patterns')).getAllByRole('tab');
    expect(tabs.reduce((total, tab) => total + Number(tab.dataset.count), 0)).toBe(
      richPatterns.length,
    );
    expect(richPatterns.length).toBe(rich.suspicious_patterns_preview.total);

    // A group with nothing in it says so. No row is invented to fill the table.
    for (const empty of ['location', 'bridge']) {
      expect(tabCount(empty)).toBe(0);
      fireEvent.click(screen.getByTestId(`preview-tab-${empty}`));
      const shown = screen.getByTestId(`preview-panel-${empty}`);
      expect(within(shown).getByTestId('empty-state')).toBeInTheDocument();
      expect(screen.queryAllByTestId('preview-pattern-row')).toHaveLength(0);
    }

    // Still a preview: the labelling on the screen has not changed.
    expect(screen.getByTestId('preview-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
  });

  it('reads every column off the detector’s own detail', async () => {
    await previewRich();

    // Cycles — the path, its length, its value and the transaction records.
    const cycle = detailOf('TRANSACTION_CYCLE');
    const cycles = screen.getByTestId('preview-panel-cycles');
    expect(within(cycles).getByText(String(cycle.cycle_path))).toBeInTheDocument();
    expect(
      within(cycles).getByText(formatInr(Number(cycle.total_amount_inr))),
    ).toBeInTheDocument();
    const legs = cycle.legs as Array<{ evidence_ids: string[] }>;
    expect(cycles.textContent).toContain(legs[0].evidence_ids[0]);

    // Multi-channel — both persons, the channel count, the relationship types.
    fireEvent.click(screen.getByTestId('preview-tab-multi'));
    const multi = screen.getByTestId('preview-panel-multi');
    const pair = richPatterns.find((p) => p.pattern_type === 'MULTI_CHANNEL_RELATIONSHIP')!;
    for (const entityId of pair.entity_ids) {
      expect(within(multi).getByText(entityId)).toBeInTheDocument();
    }
    expect(within(multi).getByText(pair.relationship_types.join(', '))).toBeInTheDocument();
    expect(
      within(multi).getByText(formatCount(Number(detailOf('MULTI_CHANNEL_RELATIONSHIP').channel_count))),
    ).toBeInTheDocument();

    // Communication anomalies — the person, the peak day, the z-score measured
    // against that person's own baseline.
    fireEvent.click(screen.getByTestId('preview-tab-comms'));
    const comms = screen.getByTestId('preview-panel-comms');
    const anomaly = detailOf('COMMUNICATION_ANOMALY');
    expect(within(comms).getByText(`person:${anomaly.person_id}`)).toBeInTheDocument();
    expect(within(comms).getByText(String(anomaly.peak_date))).toBeInTheDocument();
    expect(within(comms).getByText(formatMetric(Number(anomaly.z_score), 2))).toBeInTheDocument();

    // Transaction anomalies — Phase 4 reports fan-in, fan-out and concentration
    // per person, so the table names the hub and its counterparties. There is no
    // per-transaction score in the response, and none is displayed as if there were.
    fireEvent.click(screen.getByTestId('preview-tab-txn'));
    const txn = screen.getByTestId('preview-panel-txn');
    const fanIn = detailOf('TRANSACTION_FAN_IN');
    expect(within(txn).getAllByTestId('preview-pattern-row')).toHaveLength(tabCount('txn'));
    expect(within(txn).getByText('TRANSACTION_FAN_IN')).toBeInTheDocument();
    expect(txn.textContent).toContain(String(fanIn.hub));
    expect(txn.textContent).toContain((fanIn.counterparties as string[])[0]);
    expect(within(txn).getAllByText(formatInr(Number(fanIn.total_amount_inr))).length).toBeGreaterThan(0);
  });

  it('ranks the overlay’s central persons and lists its communities', async () => {
    await previewRich();

    // Key players: the ranking of the same centralities the metrics come from.
    const players = within(screen.getByTestId('preview-key-players'));
    const playerRows = players.getAllByTestId('preview-key-player-row');
    expect(playerRows).toHaveLength(richPlayers.length);
    const first = richPlayers[0];
    expect(within(playerRows[0]).getByText(first.entity_id.split(':')[1])).toBeInTheDocument();
    expect(within(playerRows[0]).getByText(String(first.name))).toBeInTheDocument();
    for (const metric of [first.degree_centrality, first.betweenness, first.pagerank]) {
      expect(within(playerRows[0]).getByText(formatMetric(metric, 6))).toBeInTheDocument();
    }
    expect(
      within(playerRows[0]).getByText(formatCount(first.community_id)),
    ).toBeInTheDocument();
    // Only a person this import actually touched is marked as one.
    expect(screen.queryAllByText('In this import')).toHaveLength(
      richPlayers.filter((player) => player.in_import).length,
    );

    // Communities: the detected memberships, sampled by the backend, with the
    // real remainder stated rather than a padded list.
    const communities = within(screen.getByTestId('preview-communities'));
    const communityRows = communities.getAllByTestId('preview-community-row');
    expect(communityRows).toHaveLength(richCommunities.length);
    const one = richCommunities[0];
    expect(within(communityRows[0]).getByText(formatCount(one.size))).toBeInTheDocument();
    expect(communityRows[0].textContent).toContain(String(one.member_names[0]));
    expect(communityRows[0].textContent).toContain(
      `+${formatCount(one.size - one.members_sample.length)} more`,
    );
    expect(one.members_sample.length).toBeLessThan(one.size);

    // The graph panel is still there, beside the tables, and still the overlay's.
    expect(screen.getByTestId('network-graph')).toBeInTheDocument();
    expect(
      within(statTile('Graph entities')).getByText(
        formatCount(rich.metrics_preview.graph.node_count),
      ),
    ).toBeInTheDocument();
  });
});

describe('LiveIndicator — the connection state, honestly', () => {
  it('says the stream is off when the browser has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    renderWithRouter(<LiveIndicator />);

    expect(screen.getByTestId('live-indicator')).toHaveAttribute('data-status', 'offline');
    expect(screen.getByText('Live off')).toBeInTheDocument();
  });

  it('goes connecting → live → offline with the transport', () => {
    const sse = installEventSource();
    renderWithRouter(<LiveIndicator />);

    const indicator = () => screen.getByTestId('live-indicator');
    expect(indicator()).toHaveAttribute('data-status', 'connecting');
    expect(sse.instances).toHaveLength(1);
    expect(sse.latest().url).toContain('/api/v1/ingest/stream');

    sse.open();
    expect(indicator()).toHaveAttribute('data-status', 'live');
    expect(screen.getByText('LIVE')).toBeInTheDocument();

    // The browser retrying on its own is not "offline"; giving up is.
    sse.fail({ retrying: true });
    expect(indicator()).toHaveAttribute('data-status', 'connecting');
    sse.fail();
    expect(indicator()).toHaveAttribute('data-status', 'offline');
  });

  it('opens one connection for two mounted subscribers and closes it after both', () => {
    const sse = installEventSource();
    const first = renderWithRouter(<LiveIndicator />);
    const second = renderWithRouter(<LiveIndicator />);

    expect(sse.instances).toHaveLength(1);

    first.unmount();
    expect(sse.latest().closed).toBe(false);
    second.unmount();
    expect(sse.latest().closed).toBe(true);
  });

  it('listens for every frame name the backend sends', () => {
    const sse = installEventSource();
    renderWithRouter(<LiveIndicator />);

    // The recordings are real SSE sessions; every type in them must be a type the
    // client registered a listener for, or those frames would arrive nowhere.
    const recorded = new Set(
      [
        ...(fixtures.liveEvents as Array<{ event_type: string }>),
        ...stageFrames,
      ].map((event) => event.event_type),
    );
    expect(recorded.size).toBe(6);
    for (const type of recorded) {
      expect(LIVE_EVENT_TYPES as readonly string[]).toContain(type);
      expect(sse.latest().named.get(type)?.size ?? 0).toBeGreaterThan(0);
    }
  });

  it('carries no record content over the stream', () => {
    // §12: the frames say what changed, not what was written. The record body is
    // fetched over REST, where it is subject to the same rules as everything else.
    const raw = JSON.stringify([fixtures.liveEvents, stageFrames]);
    for (const key of ['narrative', 'raw_payload', 'normalized_payload', 'name', 'phone', 'aadhaar']) {
      expect(raw).not.toContain(`"${key}"`);
    }
  });
});

describe('the live channel refreshes the screen it belongs to', () => {
  it('refetches the queue on new intelligence, without a reload', async () => {
    const { calls } = installFetch();
    const sse = installEventSource();
    renderWithRouter(<AlertsPage />, { route: '/alerts' });

    await waitFor(() => expect(screen.getAllByTestId('queue-row').length).toBeGreaterThan(0));
    sse.open();
    const rankingCalls = () => calls.filter((url) => url.includes('/intelligence/persons/top'));
    const before = rankingCalls().length;
    expect(before).toBeGreaterThan(0);

    // A frame that cannot have moved a score must not cost a request.
    sse.push(liveEvent('entity_updated'));
    expect(rankingCalls()).toHaveLength(before);

    // The last frame of an accepted record is the one that refreshes.
    sse.push(liveEvent('new_intelligence'));
    await waitFor(() => expect(rankingCalls().length).toBe(before + 1));

    // Refreshed in place: the queue never emptied and no reload happened.
    expect(screen.getAllByTestId('queue-row').length).toBeGreaterThan(0);
  });

  it('refreshes once per accepted record, not once per frame', async () => {
    const { calls } = installFetch();
    const sse = installEventSource();
    renderWithRouter(<AlertsPage />, { route: '/alerts' });

    await waitFor(() => expect(screen.getAllByTestId('queue-row').length).toBeGreaterThan(0));
    sse.open();
    const rankingCalls = () => calls.filter((url) => url.includes('/intelligence/persons/top'));
    const before = rankingCalls().length;

    // One accepted record publishes the whole recorded sequence.
    for (const event of fixtures.liveEvents as Array<{ event_type: string }>) {
      sse.push(event as { event_type: string });
    }

    await waitFor(() => expect(rankingCalls().length).toBe(before + 1));
    expect(rankingCalls()).toHaveLength(before + 1);
  });

  it('offers the write surface once, from the header, and not a second time on a page', async () => {
    installFetch();
    installEventSource();
    const { container } = renderWithRouter(<UploadCsvButton />);

    // Closed by default: the button is compact, and the import is a modal.
    expect(screen.queryByTestId('csv-import')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-upload'));

    const modal = await screen.findByTestId('upload-modal');
    expect(within(modal).getByTestId('csv-import')).toBeInTheDocument();
    expect(within(modal).getByTestId('csv-file')).toBeInTheDocument();
    // Nothing to decide about until a file has actually been judged.
    expect(within(modal).queryByTestId('csv-confirm')).not.toBeInTheDocument();
    expect(within(modal).queryByTestId('csv-reject')).not.toBeInTheDocument();

    // The overlay hangs off the document, not off the button. jsdom cannot see
    // this one: the top bar sets `backdrop-blur`, which makes the header a
    // containing block for fixed-position descendants, so an overlay left inside
    // it is clipped to the header's 52px box and only the dialog's title bar is
    // ever on screen. The portal is what keeps `fixed inset-0` meaning the
    // viewport.
    expect(container.contains(modal)).toBe(false);
    expect(modal.parentElement).toBe(document.body);
  });

  it('does not duplicate the import surface onto the priorities screen', async () => {
    installFetch();
    installEventSource();
    renderWithRouter(<AlertsPage />, { route: '/alerts' });

    // The queue has to have rendered, or "no import here" would be vacuous.
    await waitFor(() => expect(screen.getByTestId('priority-panel')).toBeInTheDocument());
    expect(screen.queryByTestId('csv-import')).not.toBeInTheDocument();
  });
});
