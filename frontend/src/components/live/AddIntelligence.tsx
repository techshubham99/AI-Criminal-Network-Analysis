/**
 * Add Intelligence — submit one new record into the live investigation store.
 *
 * The only write surface in this application. Four record types, one compact form
 * each, and the pipeline's verdict shown underneath. Nothing here decides
 * anything: the client normalises nothing, matches nothing and connects nothing.
 * It posts what was typed and displays what the backend answered — which is why a
 * REJECTED or REVIEW_REQUIRED outcome renders exactly as fully as an accepted one.
 *
 * A person is identified by whatever the operator has: a row id, a 10-digit phone,
 * a 12-digit Aadhaar, or a name. The field is read as the identifier its own shape
 * implies and sent as that; if it matches nothing, the backend says so rather than
 * guessing.
 */
import { useState, type FormEvent, type ReactElement } from 'react';

import { api, ApiError } from '@/api';
import {
  Badge,
  Button,
  ErrorState,
  Panel,
  PanelBody,
  PanelHeader,
  SegmentedControl,
} from '@/components/ui';
import type { IngestRecordOut, PersonRef } from '@/types/api';

import { IngestVerdict } from './IngestVerdict';

type Kind = 'call' | 'transaction' | 'fir' | 'location';

const KINDS: ReadonlyArray<{ value: Kind; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'transaction', label: 'Transaction' },
  { value: 'fir', label: 'FIR' },
  { value: 'location', label: 'Location' },
];

/** Party labels per record type. `b` is absent where the type has one party. */
const PARTIES: Record<Kind, { a: string; b?: string }> = {
  call: { a: 'Caller', b: 'Receiver' },
  transaction: { a: 'Sender', b: 'Receiver' },
  fir: { a: 'Complainant', b: 'Accused (optional)' },
  location: { a: 'Person' },
};

const PAYMENT_MODES = ['UPI', 'NEFT', 'IMPS', 'CASH'] as const;

interface FormState {
  source: string;
  partyA: string;
  partyB: string;
  when: string;
  date: string;
  narrative: string;
  duration: string;
  amount: string;
  mode: string;
  reference: string;
  city: string;
  state: string;
}

const EMPTY: FormState = {
  source: 'manual-entry',
  partyA: '',
  partyB: '',
  when: '',
  date: '',
  narrative: '',
  duration: '',
  amount: '',
  mode: 'UPI',
  reference: '',
  city: '',
  state: '',
};

/**
 * Read a typed identifier as the kind of identifier its shape implies.
 * Digits only: 12 → Aadhaar, 10 → phone, anything else → a row id. Otherwise a
 * name. No cross-field inference; the backend's resolver decides what it matches.
 */
export function toPersonRef(raw: string): PersonRef | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const digits = text.replace(/[\s-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length === 12) return { aadhaar: digits };
    if (digits.length === 10) return { phone: digits };
    return { person_id: Number(digits) };
  }
  return { name: text };
}

/** The first field-level complaint out of a 422, if the envelope carries one. */
function fieldDetail(error: ApiError): string | null {
  if (!Array.isArray(error.detail)) return null;
  const first = error.detail[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const loc = Array.isArray(first.loc) ? first.loc.filter((p) => p !== 'body').join('.') : '';
  const msg = typeof first.msg === 'string' ? first.msg : '';
  return [loc, msg].filter(Boolean).join(': ') || null;
}

export function AddIntelligence({
  onSubmitted,
}: {
  /** Called with the verdict after every completed submission. */
  onSubmitted?: (record: IngestRecordOut) => void;
} = {}): ReactElement {
  const [kind, setKind] = useState<Kind>('call');
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<IngestRecordOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const parties = PARTIES[kind];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const provenance = { source_name: form.source.trim() || 'manual-entry' };
    const a = toPersonRef(form.partyA);
    const b = toPersonRef(form.partyB);

    try {
      let result: IngestRecordOut;
      if (kind === 'call') {
        result = await api.ingestCall({
          provenance,
          caller: a ?? {},
          callee: b ?? {},
          start_time: form.when,
          duration_sec: form.duration,
        });
      } else if (kind === 'transaction') {
        result = await api.ingestTransaction({
          provenance,
          sender: a ?? {},
          receiver: b ?? {},
          amount_inr: form.amount,
          txn_time: form.when,
          mode: form.mode,
          bank_ref: form.reference.trim() || undefined,
        });
      } else if (kind === 'fir') {
        result = await api.ingestFir({
          provenance,
          date: form.date,
          complainant: a ?? {},
          accused: b,
          narrative: form.narrative,
          city: form.city.trim() || undefined,
          state: form.state.trim() || undefined,
        });
      } else {
        result = await api.ingestLocation({
          provenance,
          person: a ?? {},
          observed_at: form.when || undefined,
          city: form.city.trim() || undefined,
          state: form.state.trim() || undefined,
        });
      }
      setRecord(result);
      onSubmitted?.(result);
    } catch (cause) {
      setRecord(null);
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError({
              message: cause instanceof Error ? cause.message : String(cause),
              status: 0,
              code: 'unknown',
              url: '',
            }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="flex min-w-0 flex-col" data-testid="add-intelligence">
      <PanelHeader
        title="Add intelligence"
        subtitle="One record at a time. Validated before anything is stored."
        accent
        actions={
          <SegmentedControl
            label="Record type"
            options={KINDS}
            value={kind}
            onChange={(next) => {
              setKind(next);
              setRecord(null);
              setError(null);
            }}
            disabled={busy}
          />
        }
      />
      <PanelBody className="space-y-3">
        <form className="space-y-2.5" onSubmit={submit}>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field
              label={parties.a}
              hint="Row id, phone, Aadhaar or name"
              value={form.partyA}
              onChange={(value) => set('partyA', value)}
              required
            />
            {parties.b ? (
              <Field
                label={parties.b}
                hint="Row id, phone, Aadhaar or name"
                value={form.partyB}
                onChange={(value) => set('partyB', value)}
                required={kind !== 'fir'}
              />
            ) : null}

            {kind === 'call' ? (
              <>
                <Field
                  label="Start time"
                  type="datetime-local"
                  value={form.when}
                  onChange={(value) => set('when', value)}
                  required
                />
                <Field
                  label="Duration (sec)"
                  type="number"
                  value={form.duration}
                  onChange={(value) => set('duration', value)}
                  required
                />
              </>
            ) : null}

            {kind === 'transaction' ? (
              <>
                <Field
                  label="Amount (INR)"
                  type="number"
                  value={form.amount}
                  onChange={(value) => set('amount', value)}
                  required
                />
                <Field
                  label="Time"
                  type="datetime-local"
                  value={form.when}
                  onChange={(value) => set('when', value)}
                  required
                />
                <Select
                  label="Mode"
                  value={form.mode}
                  options={PAYMENT_MODES}
                  onChange={(value) => set('mode', value)}
                />
                <Field
                  label="Reference"
                  hint="Bank or UPI reference"
                  value={form.reference}
                  onChange={(value) => set('reference', value)}
                  required
                />
              </>
            ) : null}

            {kind === 'fir' ? (
              <>
                <Field
                  label="Date"
                  type="date"
                  value={form.date}
                  onChange={(value) => set('date', value)}
                  required
                />
                <Field
                  label="City"
                  value={form.city}
                  onChange={(value) => set('city', value)}
                />
                <Field
                  label="State"
                  value={form.state}
                  onChange={(value) => set('state', value)}
                />
              </>
            ) : null}

            {kind === 'location' ? (
              <>
                <Field
                  label="City"
                  value={form.city}
                  onChange={(value) => set('city', value)}
                  required
                />
                <Field
                  label="State"
                  value={form.state}
                  onChange={(value) => set('state', value)}
                  required
                />
                <Field
                  label="Observed at"
                  type="datetime-local"
                  value={form.when}
                  onChange={(value) => set('when', value)}
                />
              </>
            ) : null}

            <Field
              label="Source"
              hint="Stated origin; stored verbatim"
              value={form.source}
              onChange={(value) => set('source', value)}
              required
            />
          </div>

          {kind === 'fir' ? (
            <label className="block">
              <span className="field-label">Narrative</span>
              <textarea
                rows={3}
                value={form.narrative}
                onChange={(event) => set('narrative', event.target.value)}
                required
                className="border-line bg-inset text-ink placeholder:text-ink-4 focus:border-line-accent mt-1 w-full rounded-sm border px-2 py-1.5 text-xs outline-none"
              />
            </label>
          ) : null}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm" loading={busy}>
              Submit record
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setForm(EMPTY);
                setRecord(null);
                setError(null);
              }}
            >
              Clear
            </Button>
            <Badge tone="muted">Synthetic data only</Badge>
          </div>
        </form>

        {error ? (
          <div data-testid="ingest-error">
            <ErrorState error={error} compact />
            {fieldDetail(error) ? (
              <p className="text-alert-300 mt-1 text-2xs">{fieldDetail(error)}</p>
            ) : null}
          </div>
        ) : null}

        {record ? <IngestVerdict record={record} /> : null}
      </PanelBody>
    </Panel>
  );
}

/* -------------------------------------------------------------------- fields -- */

function Field({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'date' | 'datetime-local';
  hint?: string;
  required?: boolean;
}): ReactElement {
  return (
    <label className="block min-w-0">
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={hint}
        onChange={(event) => onChange(event.target.value)}
        className="border-line bg-inset text-ink placeholder:text-ink-4 focus:border-line-accent mt-1 w-full rounded-sm border px-2 py-1.5 text-xs outline-none"
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="block min-w-0">
      <span className="field-label">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-line bg-inset text-ink focus:border-line-accent mt-1 w-full rounded-sm border px-2 py-1.5 text-xs outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
