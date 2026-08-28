/**
 * Phase 4 intelligence panels.
 *
 * Every component here reads live `/api/v1/intelligence/*` responses. None of them
 * computes a score, merges the two evidence classes, or renders a priority figure
 * without its derivation reachable on the same screen.
 */
export { PriorityPanel } from './PriorityPanel';
export { PriorityExplain } from './PriorityExplain';
export { PersonIntelligence } from './PersonIntelligence';
export { PatternList } from './PatternList';
export { PatternDetails } from './PatternDetails';
export { FactorBreakdown } from './FactorBreakdown';
export { ScoreReadout } from './ScoreReadout';
export { EvidenceList, EvidencePair } from './EvidenceList';
export { ActivityTimeline } from './Timeline';
export {
  BAND_BAR_CLASS,
  BAND_TEXT_CLASS,
  BAND_TONE,
  FEATURE_LABELS,
  featureLabel,
  patternTypeLabel,
} from './labels';
