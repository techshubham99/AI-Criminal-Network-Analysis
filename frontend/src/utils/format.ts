/** Small, dependency-free formatters. */

const NUMBER = new Intl.NumberFormat('en-IN');

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return NUMBER.format(value);
}

/** Indian-format rupees, no decimals. Amounts come from the dataset as INR. */
export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}`;
}

/** 3529 -> "58m 49s" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rest}s`;
  return `${rest}s`;
}

/**
 * Dates arrive as ISO date (`2026-06-26`) or ISO datetime
 * (`2026-08-22T09:40:31`). Render them readably without inventing precision:
 * a date-only value never grows a time.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  const d = parsed.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  if (dateOnly) return d;
  const t = parsed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${d} ${t}`;
}

/** A date range that collapses when both ends are the same instant. */
export function formatDateRange(
  first: string | null | undefined,
  last: string | null | undefined,
): string {
  if (!first && !last) return '—';
  if (!last || first === last) return formatDateTime(first);
  if (!first) return formatDateTime(last);
  return `${formatDateTime(first)} → ${formatDateTime(last)}`;
}

/** 0.7 -> "0.70" — confidences are always shown at two decimals, never as %. */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

/** Centrality figures: keep the backend's precision, drop trailing noise. */
export function formatMetric(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(digits);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** `known_record` -> `Known record`; used for method/status labels. */
export function humanizeToken(token: string | null | undefined): string {
  if (!token) return '—';
  const cleaned = token.replace(/^rule:/, '').replace(/[_~]+/g, ' ').trim();
  if (!cleaned) return token;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Turn `{a: 2, b: 1}` into `[['a',2],['b',1]]` sorted by count desc, then key. */
export function sortedCounts(
  counts: Record<string, number> | null | undefined,
): Array<[string, number]> {
  if (!counts) return [];
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function sumCounts(counts: Record<string, number> | null | undefined): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((total, n) => total + (Number.isFinite(n) ? n : 0), 0);
}
