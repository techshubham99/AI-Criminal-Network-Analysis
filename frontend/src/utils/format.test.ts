/**
 * Formatters. The interesting cases here are not the happy paths but the two
 * honesty rules the formatters carry on their own:
 *
 *  - a missing value renders as an em dash, never as 0, because "not reported"
 *    and "zero" are different claims about the evidence;
 *  - a date-only value never grows a time it never had.
 */
import { describe, expect, it } from 'vitest';

import {
  formatConfidence,
  formatCount,
  formatDateRange,
  formatDateTime,
  formatDuration,
  formatInr,
  formatMetric,
  formatPercent,
  humanizeToken,
  sortedCounts,
  sumCounts,
  truncate,
} from './format';

const ABSENT = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY];

describe('absent is not zero', () => {
  it.each(ABSENT)('formatCount(%s) is an em dash', (value) => {
    expect(formatCount(value as number)).toBe('—');
  });

  it.each(ABSENT)('formatInr(%s) is an em dash', (value) => {
    expect(formatInr(value as number)).toBe('—');
  });

  it.each(ABSENT)('formatMetric(%s) is an em dash', (value) => {
    expect(formatMetric(value as number)).toBe('—');
  });

  it.each(ABSENT)('formatConfidence(%s) is an em dash', (value) => {
    expect(formatConfidence(value as number)).toBe('—');
  });

  it.each(ABSENT)('formatDuration(%s) is an em dash', (value) => {
    expect(formatDuration(value as number)).toBe('—');
  });

  it('but a real zero still prints as zero', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatMetric(0)).toBe('0');
    expect(formatConfidence(0)).toBe('0.00');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('formatCount', () => {
  it('groups digits without altering the number', () => {
    const formatted = formatCount(1234567);
    expect(formatted).toMatch(/^[\d,]+$/);
    expect(formatted.replace(/,/g, '')).toBe('1234567');
    expect(formatted).toContain(',');
  });

  it('leaves small counts alone', () => {
    expect(formatCount(600)).toBe('600');
  });
});

describe('formatInr', () => {
  it('prefixes the rupee sign and drops decimals', () => {
    const formatted = formatInr(1250000.4);
    expect(formatted.startsWith('₹')).toBe(true);
    expect(formatted).not.toContain('.');
    expect(formatted.replace(/[₹,]/g, '')).toBe('1250000');
  });
});

describe('formatDuration', () => {
  it('renders under an hour as minutes and seconds', () => {
    expect(formatDuration(3529)).toBe('58m 49s');
  });

  it('drops seconds once hours are involved, rather than faking precision', () => {
    expect(formatDuration(7200)).toBe('2h 0m');
    expect(formatDuration(3661)).toBe('1h 1m');
  });

  it('renders under a minute as seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('clamps a negative duration instead of printing one', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('formatDateTime', () => {
  it('renders a date-only value with no time appended', () => {
    const formatted = formatDateTime('2026-06-26');
    expect(formatted).toMatch(/^\d{2} \w{3} \d{4}$/);
    expect(formatted).not.toMatch(/\d{2}:\d{2}/);
  });

  it('renders a datetime with hours and minutes and no seconds', () => {
    const formatted = formatDateTime('2026-08-22T09:40:31');
    expect(formatted).toMatch(/^\d{2} \w{3} \d{4} \d{2}:\d{2}$/);
    expect(formatted).not.toContain('31');
  });

  it('returns the original string when it cannot be parsed, rather than "Invalid Date"', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
  });

  it('is an em dash for an absent value', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('')).toBe('—');
  });
});

describe('formatDateRange', () => {
  it('collapses when both ends are the same instant', () => {
    expect(formatDateRange('2026-06-26', '2026-06-26')).toBe(formatDateTime('2026-06-26'));
  });

  it('shows an arrow between two distinct ends', () => {
    expect(formatDateRange('2026-06-26', '2026-07-01')).toContain('→');
  });

  it('falls back to whichever end exists', () => {
    expect(formatDateRange('2026-06-26', null)).toBe(formatDateTime('2026-06-26'));
    expect(formatDateRange(null, '2026-07-01')).toBe(formatDateTime('2026-07-01'));
    expect(formatDateRange(null, null)).toBe('—');
  });
});

describe('formatConfidence', () => {
  it('is never a percentage — the backend never measured a calibration', () => {
    expect(formatConfidence(0.7)).toBe('0.70');
    expect(formatConfidence(0.95)).toBe('0.95');
    expect(formatConfidence(0.7)).not.toContain('%');
  });
});

describe('formatMetric', () => {
  it('keeps enough precision to show a small centrality figure', () => {
    expect(formatMetric(0.004731, 6)).toBe('0.004731');
    expect(formatMetric(0.007493, 6)).toBe('0.007493');
  });

  it('defaults to four decimals below one', () => {
    expect(formatMetric(0.004731)).toBe('0.0047');
  });

  it('uses two decimals at or above one', () => {
    expect(formatMetric(29)).toBe('29.00');
  });
});

describe('formatPercent', () => {
  it('appends the sign at one decimal by default', () => {
    expect(formatPercent(94.2)).toBe('94.2%');
    expect(formatPercent(94.25, 0)).toBe('94%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('humanizeToken', () => {
  it('strips the rule: prefix the extractor puts on method names', () => {
    expect(humanizeToken('rule:known_record')).toBe('Known record');
  });

  it('turns underscores into spaces and capitalises once', () => {
    expect(humanizeToken('accepted_additive')).toBe('Accepted additive');
    expect(humanizeToken('not_applicable')).toBe('Not applicable');
  });

  it('is an em dash for an absent token', () => {
    expect(humanizeToken(null)).toBe('—');
    expect(humanizeToken('')).toBe('—');
  });

  it('returns the original when stripping would leave nothing', () => {
    expect(humanizeToken('rule:')).toBe('rule:');
  });
});

describe('truncate', () => {
  it('leaves a short string untouched', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('adds an ellipsis inside the budget rather than beyond it', () => {
    const out = truncate('abcdefghij', 4);
    expect(out).toBe('abc…');
    expect(out.length).toBe(4);
  });
});

describe('sortedCounts', () => {
  it('sorts by count descending, then by key for a stable tie', () => {
    expect(sortedCounts({ b: 1, a: 2, c: 2 })).toEqual([
      ['a', 2],
      ['c', 2],
      ['b', 1],
    ]);
  });

  it('is empty for an absent dict', () => {
    expect(sortedCounts(null)).toEqual([]);
    expect(sortedCounts(undefined)).toEqual([]);
  });
});

describe('sumCounts', () => {
  it('adds the values', () => {
    expect(sumCounts({ PERSON: 600, PHONE: 600 })).toBe(1200);
  });

  it('is zero for an absent dict, and skips non-finite entries', () => {
    expect(sumCounts(null)).toBe(0);
    expect(sumCounts({ a: 1, b: Number.NaN })).toBe(1);
  });
});
