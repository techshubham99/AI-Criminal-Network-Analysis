/**
 * The scope control at the head of every domain screen.
 *
 * Communication, Financial and Locations are corpus-wide by default and narrow to
 * one subject on request. This is the control that does the narrowing: a person
 * search when nothing is scoped, and the subject with a way out when something is.
 *
 * Scope lives in the URL (`?person=445`), so a scoped screen is linkable and the
 * browser's back button unwinds it.
 */
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { api } from '@/api';
import { Button, Mono, Spinner } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 8;

export function SubjectScope({
  personId,
  label,
  onChange,
}: {
  personId: number | null;
  /** The scoped person's name, once the caller has it. */
  label?: string | null;
  onChange: (personId: number | null) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query.trim(), 250);
  const enabled = personId === null && debounced.length >= MIN_QUERY_LENGTH;

  const results = useAsync(
    (signal) => api.listPersons({ q: debounced, page_size: RESULT_LIMIT }, { signal }),
    [debounced],
    { enabled },
  );

  if (personId !== null) {
    return (
      <div
        className="border-line-accent bg-panel-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        data-testid="subject-scope"
        data-person-id={personId}
      >
        <span className="field-label">Scoped to</span>
        <span className="text-ink truncate text-xs font-semibold">{label ?? `person:${personId}`}</span>
        <Mono className="text-2xs">{personId}</Mono>
        <div className="ml-auto flex items-center gap-2">
          <Link
            to={`/network/${personId}`}
            className="border-cyan-600/55 bg-cyan-500/14 text-cyan-200 hover:bg-cyan-500/22 inline-flex h-7 items-center rounded-sm border px-2.5 text-2xs font-semibold transition-colors"
          >
            Investigate
          </Link>
          <Button size="sm" onClick={() => onChange(null)}>
            Reset
          </Button>
        </div>
      </div>
    );
  }

  const items = results.data?.items ?? [];

  return (
    <div className="relative" data-testid="subject-scope">
      <div className="border-line bg-panel-2 flex items-center gap-2 rounded-md border px-3 py-2">
        <span className="field-label shrink-0">Subject</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a person by name to scope this view"
          aria-label="Search a person to scope this view"
          data-testid="scope-search"
          className="text-ink placeholder:text-ink-4 min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        {results.isLoading ? <Spinner label="Searching" /> : null}
      </div>
      {enabled && results.data ? (
        <div className="border-line bg-panel elevation-2 absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border">
          {items.length === 0 ? (
            <p className="text-ink-4 px-3 py-2.5 text-xs">No matching person.</p>
          ) : (
            <ul className="divide-line divide-y">
              {items.map((person) => (
                <li key={person.person_id}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      onChange(person.person_id);
                    }}
                    data-testid="scope-result"
                    className="hover:bg-panel-2 flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
                  >
                    <span className="text-ink min-w-0 flex-1 truncate text-xs font-medium">
                      {person.name}
                    </span>
                    <span className="text-ink-4 shrink-0 text-2xs">{person.city}</span>
                    <Mono className="text-2xs shrink-0">{person.person_id}</Mono>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
