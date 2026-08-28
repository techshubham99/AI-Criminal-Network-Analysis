/**
 * Shared vocabulary for the intelligence panels.
 *
 * Two things live here rather than in each component:
 *
 *  1. FEATURE LABELS. The scoring endpoint returns a bare feature key
 *     (`bridge_network_structure`); only `/explain` carries a human label. Rather
 *     than fetch an explanation just to caption a bar, the same six labels the
 *     backend uses are mirrored here, verbatim.
 *
 *  2. BAND STYLING. Written out as full class strings in a lookup, never
 *     assembled at runtime — Tailwind v4 scans source text, so `text-${tone}-300`
 *     would generate no CSS at all.
 *
 * Colour follows the project's palette rule: LOW is neutral, MEDIUM is amber,
 * and HIGH is the one case that earns red, because a high band is an alert.
 */
import type { ScoreBand } from '@/types/api';

/** The backend's own labels for the six scored features. */
export const FEATURE_LABELS: Record<string, string> = {
  network_importance: 'Network importance',
  multi_channel_relationship: 'Multi-channel relationships',
  transaction_patterns: 'Transaction patterns',
  communication_anomaly: 'Communication anomaly',
  location_patterns: 'Location patterns',
  bridge_network_structure: 'Bridge / network structure',
};

/** Falls back to a readable form of the key, so a new feature is never blank. */
export function featureLabel(feature: string): string {
  const known = FEATURE_LABELS[feature];
  if (known) return known;
  const words = feature.replace(/[_~]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : feature;
}

/** `BRIDGE_ENTITY` -> `Bridge entity`. */
export function patternTypeLabel(patternType: string): string {
  const words = patternType.replace(/[_~]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : patternType;
}

export const BAND_TONE: Record<ScoreBand, 'neutral' | 'warn' | 'alert'> = {
  LOW: 'neutral',
  MEDIUM: 'warn',
  HIGH: 'alert',
};

export const BAND_TEXT_CLASS: Record<ScoreBand, string> = {
  LOW: 'text-ink-2',
  MEDIUM: 'text-warn-300',
  HIGH: 'text-alert-300',
};

export const BAND_BAR_CLASS: Record<ScoreBand, string> = {
  LOW: 'bg-ink-4',
  MEDIUM: 'bg-warn-400',
  HIGH: 'bg-alert-400',
};
