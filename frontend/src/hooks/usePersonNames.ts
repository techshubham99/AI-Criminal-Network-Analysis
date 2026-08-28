/**
 * A session-lifetime index from `person_id` to the person's name.
 *
 * Call, transaction and location rows identify their parties by bare integer —
 * `caller_id: 445` — and there is no backend route that expands a list of ids into
 * a list of names. Fetching one `/persons/{id}` per row would mean dozens of
 * requests per page, so instead the whole `persons` table is pulled once, in
 * `page_size=200` slices, and kept in a module-level map.
 *
 * The loop is bounded twice over: it stops when the backend says `has_next` is
 * false, and it stops unconditionally at `MAX_PAGES` pages. The second bound
 * matters because a recorded test fixture is a single page that still claims
 * `has_next: true`, and without the cap that claim would spin forever.
 *
 * Every name here is a real value read from the backend. A row whose id is absent
 * from the index renders its id, never a guess.
 */
import { useCallback, useEffect, useState } from 'react';

import { api } from '@/api';

const PAGE_SIZE = 200;

/** 5 x 200 = 1000 persons. The synthetic corpus holds 500; this is the guard. */
const MAX_PAGES = 5;

export type PersonNameIndex = ReadonlyMap<number, string>;

let cache: PersonNameIndex | null = null;
let inflight: Promise<PersonNameIndex> | null = null;

/**
 * Load (or return the already-loaded) name index. Concurrent callers share one
 * request chain; a failure clears the attempt so a later mount can retry.
 *
 * Deliberately takes no `AbortSignal`: the index is shared, so one unmounting
 * component must not cancel the load every other component is waiting on.
 */
export function loadPersonNames(): Promise<PersonNameIndex> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = (async () => {
      const names = new Map<number, string>();
      let page = 1;
      while (page <= MAX_PAGES) {
        const result = await api.listPersons({ page, page_size: PAGE_SIZE });
        for (const person of result.items) {
          names.set(person.person_id, person.name);
        }
        if (!result.meta.has_next) break;
        page += 1;
      }
      cache = names;
      return cache;
    })();
    inflight = inflight.catch((error: unknown) => {
      inflight = null;
      throw error;
    });
  }
  return inflight;
}

/** Test seam. Clears the module cache so each test starts from an empty index. */
export function resetPersonNames(): void {
  cache = null;
  inflight = null;
}

export interface PersonNames {
  /** The person's name, or `null` when the index has no entry for that id. */
  nameOf: (personId: number | null | undefined) => string | null;
  /** The name when known, else `person:{id}` — never a fabricated name. */
  labelOf: (personId: number | null | undefined) => string;
  ready: boolean;
}

/**
 * Read access to the index. Renders immediately with whatever is cached and
 * re-renders once when the load completes, so a table never blocks on names.
 */
export function usePersonNames(): PersonNames {
  const [names, setNames] = useState<PersonNameIndex | null>(cache);

  useEffect(() => {
    if (names) return;
    let live = true;
    loadPersonNames().then(
      (loaded) => {
        if (live) setNames(loaded);
      },
      () => {
        /* Names are an enrichment; rows fall back to ids and stay readable. */
      },
    );
    return () => {
      live = false;
    };
  }, [names]);

  const nameOf = useCallback(
    (personId: number | null | undefined) =>
      personId === null || personId === undefined ? null : names?.get(personId) ?? null,
    [names],
  );

  const labelOf = useCallback(
    (personId: number | null | undefined) => {
      if (personId === null || personId === undefined) return '—';
      return names?.get(personId) ?? `person:${personId}`;
    },
    [names],
  );

  return { nameOf, labelOf, ready: names !== null };
}
