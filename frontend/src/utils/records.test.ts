/**
 * Safe readers for the open dicts (`meta`, `attributes`, `weight_detail`,
 * `summary`) the backend documents as free-form. These are tested against the
 * recorded responses rather than invented objects, so a reader that would break
 * on real data breaks here.
 */
import { describe, expect, it } from 'vitest';

import {
  flattenScalars,
  readBoolean,
  readCounts,
  readNumber,
  readRecord,
  readString,
  readStringArray,
} from './records';
import { fixtures } from '@/test/helpers';

const sample: Record<string, unknown> = {
  text: 'hello',
  count: 3,
  zero: 0,
  flag: false,
  nothing: null,
  list: ['calls:213', 'calls:288'],
  mixed: ['a', { b: 1 }],
  nested: { inner: 1 },
  notFinite: Number.NaN,
};

describe('typed readers return null on the wrong type instead of coercing', () => {
  it('readString', () => {
    expect(readString(sample, 'text')).toBe('hello');
    expect(readString(sample, 'count')).toBeNull();
    expect(readString(sample, 'missing')).toBeNull();
    expect(readString(null, 'text')).toBeNull();
  });

  it('readNumber keeps a real zero but rejects NaN', () => {
    expect(readNumber(sample, 'count')).toBe(3);
    expect(readNumber(sample, 'zero')).toBe(0);
    expect(readNumber(sample, 'notFinite')).toBeNull();
    expect(readNumber(sample, 'text')).toBeNull();
  });

  it('readBoolean keeps false, which is a value not an absence', () => {
    expect(readBoolean(sample, 'flag')).toBe(false);
    expect(readBoolean(sample, 'missing')).toBeNull();
  });

  it('readStringArray drops non-string members', () => {
    expect(readStringArray(sample, 'list')).toEqual(['calls:213', 'calls:288']);
    expect(readStringArray(sample, 'mixed')).toEqual(['a']);
    expect(readStringArray(sample, 'text')).toEqual([]);
  });

  it('readRecord rejects arrays', () => {
    expect(readRecord(sample, 'nested')).toEqual({ inner: 1 });
    expect(readRecord(sample, 'list')).toBeNull();
  });
});

describe('readCounts', () => {
  it('reads a real counts dict out of a recorded response', () => {
    const counts = readCounts(
      fixtures.dataSummary as unknown as Record<string, unknown>,
      'counts',
    );
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    for (const value of Object.values(counts)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('is an empty object when the key is absent', () => {
    expect(readCounts(sample, 'missing')).toEqual({});
    expect(readCounts(null, 'counts')).toEqual({});
  });
});

describe('flattenScalars', () => {
  it('shows whatever the backend sent, skipping nulls and nested objects', () => {
    expect(flattenScalars(sample)).toEqual([
      ['text', 'hello'],
      ['count', '3'],
      ['zero', '0'],
      ['flag', 'false'],
      ['list', 'calls:213, calls:288'],
      ['notFinite', 'NaN'],
    ]);
  });

  it('preserves key order, so a panel renders fields as the backend ordered them', () => {
    const attributes = (
      fixtures.relationshipCalled as unknown as { attributes: Record<string, unknown> }
    ).attributes;
    const pairs = flattenScalars(attributes);
    expect(pairs.map(([key]) => key)).toEqual(
      Object.keys(attributes).filter((key) => {
        const value = attributes[key];
        if (value === null || value === undefined) return false;
        if (typeof value === 'object') {
          return Array.isArray(value) && value.every((v) => typeof v !== 'object');
        }
        return true;
      }),
    );
  });

  it('is empty for an absent dict', () => {
    expect(flattenScalars(null)).toEqual([]);
    expect(flattenScalars(undefined)).toEqual([]);
  });
});
