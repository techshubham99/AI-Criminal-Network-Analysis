/**
 * Safe readers for the `Record<string, unknown>` fields the backend returns as
 * open dicts (`meta`, `attributes`, `weight_detail`, `summary`, …).
 *
 * These exist so the UI can display those values without asserting a shape the
 * backend never promised in its OpenAPI document. A missing or wrong-typed key
 * yields the fallback instead of a runtime crash.
 */

export function readString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

export function readNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readBoolean(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

export function readStringArray(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function readRecord(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Counts dict (`{"PERSON": 600}`) with non-numeric entries dropped. */
export function readCounts(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, number> {
  const nested = readRecord(record, key);
  if (!nested) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(nested)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Flatten an open dict into ordered label/value pairs for display, skipping
 * nested objects and arrays. Used by the "raw attributes" sections of the
 * details panels, where the point is to show whatever the backend sent.
 */
export function flattenScalars(
  record: Record<string, unknown> | null | undefined,
): Array<[string, string]> {
  if (!record) return [];
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) {
        out.push([key, value.map((v) => String(v)).join(', ')]);
      }
      continue;
    }
    out.push([key, String(value)]);
  }
  return out;
}
