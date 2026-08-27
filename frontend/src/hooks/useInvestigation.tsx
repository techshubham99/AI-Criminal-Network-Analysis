/**
 * The "active investigation subject" — one shared, deliberately tiny piece of
 * app state.
 *
 * Scope is intentionally minimal: it holds *which* entity the operator is
 * currently working on so the top bar can name it, and nothing else. It caches
 * no responses and derives no analytics — every screen still fetches its own
 * data through `@/api`, so there is no second source of truth for anything the
 * backend owns.
 */
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * `entityId` is the PREFIXED form the backend's responses speak
 * (`person:445`, `fir:210`) because that is what we display verbatim. Anything
 * that needs a path parameter converts it with `personIdFromEntityId()` /
 * `firIdFromEntityId()` at the call site — see the TWO ID FORMS note in
 * `src/api/endpoints.ts`.
 */
export interface InvestigationSubject {
  entityId: string;
  label: string;
  kind: 'person' | 'fir';
}

interface InvestigationContextValue {
  subject: InvestigationSubject | null;
  setSubject: (subject: InvestigationSubject | null) => void;
}

/**
 * A real default rather than `undefined`, so `useInvestigation()` never throws.
 * A panel rendered on its own — in isolation, or in a unit test — degrades to
 * "no active subject" and a setter that does nothing, which is the honest
 * behaviour when there is no shell to display a subject in.
 */
const NO_INVESTIGATION: InvestigationContextValue = {
  subject: null,
  setSubject: () => {},
};

const InvestigationContext = createContext<InvestigationContextValue>(NO_INVESTIGATION);

export function InvestigationProvider({ children }: { children: ReactNode }): ReactElement {
  const [subject, setSubject] = useState<InvestigationSubject | null>(null);

  // `setSubject` from useState is already referentially stable, so the memo
  // only re-creates the value when the subject actually changes — consumers of
  // the context do not re-render on unrelated shell renders.
  const value = useMemo<InvestigationContextValue>(() => ({ subject, setSubject }), [subject]);

  return <InvestigationContext.Provider value={value}>{children}</InvestigationContext.Provider>;
}

export function useInvestigation(): InvestigationContextValue {
  return useContext(InvestigationContext);
}
