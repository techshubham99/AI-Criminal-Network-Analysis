/**
 * The `?person=` scope shared by the Communication, Financial and Locations
 * screens.
 *
 * Each of those screens is a corpus-wide browser by default and a per-subject view
 * when a subject is selected. Two things can select one: the URL, and the active
 * investigation subject the shell already tracks. The URL wins when both are set,
 * so a link is never overridden by leftover session state.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useInvestigation } from './useInvestigation';
import { personIdFromEntityId } from '@/utils/entity';

export interface PersonScope {
  personId: number | null;
  setPersonId: (personId: number | null) => void;
  /** True when the scope came from the active subject rather than the URL. */
  inherited: boolean;
}

export function usePersonScope(): PersonScope {
  const [params, setParams] = useSearchParams();
  const { subject } = useInvestigation();

  const raw = params.get('person');
  const fromUrl = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const fromSubject = subject?.kind === 'person' ? personIdFromEntityId(subject.entityId) : null;
  const personId = fromUrl ?? fromSubject;

  const setPersonId = useCallback(
    (next: number | null) => {
      setParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          /*
           * An explicit empty `?person=` is the "cleared" marker. Deleting the
           * parameter instead would let the active subject re-apply the scope the
           * operator just dismissed.
           */
          updated.set('person', next === null ? '' : String(next));
          /* A different subject means a different record set; page 1 again. */
          updated.delete('page');
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const cleared = raw === '';
  return {
    personId: cleared ? null : personId,
    setPersonId,
    inherited: !cleared && fromUrl === null && fromSubject !== null,
  };
}
