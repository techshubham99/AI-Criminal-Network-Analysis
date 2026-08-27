/**
 * Entity-type vocabulary shared by the graph, tables, badges and legend.
 *
 * Two facts about this backend that the UI must not paper over:
 *
 *  1. The Phase 2 graph materialises SIX node types — PERSON, PHONE, AADHAAR,
 *     LOCATION, FIR, CELL_TOWER. There is NO TRANSACTION node: money movement
 *     is a `TRANSACTED` *edge* between two persons. VEHICLE / ORGANIZATION /
 *     EVENT are declared by the backend as `future_node_types` and are not
 *     present, so they are styled here only as a graceful fallback.
 *
 *  2. Entity ids are prefixed strings: `person:445`, `phone:+91-...`,
 *     `aadhaar:591477314669`, `location:23`, `fir:210`, `tower:2404`.
 *     Narrative-derived edge ids additionally carry a `narr~` prefix.
 */

export interface EntityTypeStyle {
  /** Canonical label for the UI. */
  label: string;
  /** CSS colour (hex) — shared by Cytoscape and DOM badges. */
  color: string;
  /** Tailwind classes for a small badge. */
  badgeClass: string;
  /** One-line explanation, surfaced as a tooltip. */
  hint: string;
}

export const UNKNOWN_ENTITY_STYLE: EntityTypeStyle = {
  label: 'UNKNOWN',
  color: '#64748b',
  badgeClass: 'bg-ent-unknown/12 text-ink-2 ring-ent-unknown/30',
  hint: 'An entity type this build does not have styling for.',
};

export const ENTITY_TYPE_STYLES: Record<string, EntityTypeStyle> = {
  PERSON: {
    label: 'PERSON',
    color: '#38bdf8',
    badgeClass: 'bg-ent-person/12 text-ent-person ring-ent-person/30',
    hint: 'An individual from persons.csv. Neutral subject of analysis — never labelled criminal.',
  },
  PHONE: {
    label: 'PHONE',
    color: '#c084fc',
    badgeClass: 'bg-ent-phone/12 text-ent-phone ring-ent-phone/30',
    hint: 'A phone number owned by a person (OWNS_PHONE).',
  },
  AADHAAR: {
    label: 'AADHAAR',
    color: '#2dd4bf',
    badgeClass: 'bg-ent-aadhaar/12 text-ent-aadhaar ring-ent-aadhaar/30',
    hint: 'A 12-digit national identifier owned by a person (OWNS_AADHAAR). Synthetic value.',
  },
  LOCATION: {
    label: 'LOCATION',
    color: '#fbbf24',
    badgeClass: 'bg-ent-location/12 text-ent-location ring-ent-location/30',
    hint: 'A city/state record from locations.csv.',
  },
  FIR: {
    label: 'FIR',
    color: '#818cf8',
    badgeClass: 'bg-ent-fir/12 text-ent-fir ring-ent-fir/30',
    hint: 'A First Information Report record. Persons are linked to it by NAMED_IN_FIR.',
  },
  CELL_TOWER: {
    label: 'CELL TOWER',
    color: '#94a3b8',
    badgeClass: 'bg-ent-tower/12 text-ink-2 ring-ent-tower/30',
    hint: 'A cell tower observed in call records (USED_TOWER).',
  },
  DATE: {
    label: 'DATE',
    color: '#7dd3fc',
    badgeClass: 'bg-azure-400/12 text-azure-300 ring-azure-400/30',
    hint: 'A date mentioned in an FIR narrative. No DATE node exists in the graph, so it is carried as relationship metadata.',
  },
  MONEY: {
    label: 'MONEY',
    color: '#34d399',
    badgeClass: 'bg-ok-400/12 text-ok-300 ring-ok-400/30',
    hint: 'A currency amount. The extractor supports it; this corpus contains none.',
  },
  VEHICLE: {
    label: 'VEHICLE',
    color: '#fb923c',
    badgeClass: 'bg-warn-400/12 text-warn-300 ring-warn-400/30',
    hint: 'A vehicle registration. Declared as a future node type; not present in this dataset.',
  },
  ORGANIZATION: {
    label: 'ORGANIZATION',
    color: '#a3a3a3',
    badgeClass: 'bg-ent-unknown/12 text-ink-2 ring-ent-unknown/30',
    hint: 'An organisation name. Declared as a future node type; not present in this dataset.',
  },
};

export function entityStyle(entityType: string | null | undefined): EntityTypeStyle {
  if (!entityType) return UNKNOWN_ENTITY_STYLE;
  return ENTITY_TYPE_STYLES[entityType.toUpperCase()] ?? UNKNOWN_ENTITY_STYLE;
}

export function entityColor(entityType: string | null | undefined): string {
  return entityStyle(entityType).color;
}

/* -------------------------------------------------------------------------- */
/* Relationship vocabulary                                                    */
/* -------------------------------------------------------------------------- */

export interface RelationshipTypeStyle {
  label: string;
  color: string;
  /** Dashed lines mark relationships that are not a direct observation. */
  dashed: boolean;
  hint: string;
}

export const RELATIONSHIP_STYLES: Record<string, RelationshipTypeStyle> = {
  CALLED: {
    label: 'CALLED',
    color: '#5b9bd5',
    dashed: false,
    hint: 'A phone call observed in calls.csv. Directed caller → callee.',
  },
  TRANSACTED: {
    label: 'TRANSACTED',
    color: '#3fb99b',
    dashed: false,
    hint: 'A money transfer observed in transactions.csv. Directed sender → receiver.',
  },
  REPORTED_AGAINST: {
    label: 'REPORTED_AGAINST',
    color: '#b4646e',
    dashed: false,
    hint: 'A complainant named an accused in an FIR. An allegation on record — not a finding of guilt.',
  },
  NAMED_IN_FIR: {
    label: 'NAMED_IN_FIR',
    color: '#818cf8',
    dashed: false,
    hint: 'A person appears in an FIR record, with a role attribute (complainant / accused).',
  },
  OWNS_PHONE: {
    label: 'OWNS_PHONE',
    color: '#a78bfa',
    dashed: false,
    hint: 'The person record lists this phone number.',
  },
  OWNS_AADHAAR: {
    label: 'OWNS_AADHAAR',
    color: '#2dd4bf',
    dashed: false,
    hint: 'The person record lists this Aadhaar number.',
  },
  LOCATED_AT: {
    label: 'LOCATED_AT',
    color: '#d4a13a',
    dashed: false,
    hint: 'The subject is associated with a location record.',
  },
  CO_LOCATED: {
    label: 'CO_LOCATED',
    color: '#7c8ba1',
    dashed: true,
    hint: 'Derived, not observed: two persons share a location_id. Weak evidence by design.',
  },
  USED_TOWER: {
    label: 'USED_TOWER',
    color: '#8f9bab',
    dashed: false,
    hint: 'A call by this person was routed through this cell tower.',
  },
  SAME_RING: {
    label: 'SAME_RING',
    color: '#f472b6',
    dashed: true,
    hint: 'SYNTHETIC GROUND TRUTH from the data generator, not evidence. Excluded from this UI and from all analytics.',
  },
  ASSOCIATED_WITH: {
    label: 'ASSOCIATED_WITH',
    color: '#c084fc',
    dashed: true,
    hint: 'Asserted by FIR narrative text via an explicit association phrase.',
  },
  MET: {
    label: 'MET',
    color: '#c084fc',
    dashed: true,
    hint: 'Asserted by FIR narrative text. Supported by the extractor; absent from this corpus.',
  },
  TRANSFERRED_TO: {
    label: 'TRANSFERRED_TO',
    color: '#c084fc',
    dashed: true,
    hint: 'Asserted by FIR narrative text. Supported by the extractor; absent from this corpus.',
  },
};

export const UNKNOWN_RELATIONSHIP_STYLE: RelationshipTypeStyle = {
  label: 'RELATIONSHIP',
  color: '#5c6f85',
  dashed: false,
  hint: 'A relationship type this build does not have styling for.',
};

export function relationshipStyle(type: string | null | undefined): RelationshipTypeStyle {
  if (!type) return UNKNOWN_RELATIONSHIP_STYLE;
  return RELATIONSHIP_STYLES[type.toUpperCase()] ?? UNKNOWN_RELATIONSHIP_STYLE;
}

/* -------------------------------------------------------------------------- */
/* Entity id helpers                                                          */
/* -------------------------------------------------------------------------- */

/** `person:445` -> `{ prefix: 'person', key: '445' }` */
export function splitEntityId(entityId: string): { prefix: string; key: string } {
  const idx = entityId.indexOf(':');
  if (idx < 0) return { prefix: '', key: entityId };
  return { prefix: entityId.slice(0, idx), key: entityId.slice(idx + 1) };
}

/** Numeric person id from `person:445`, or null when the id is not a person. */
export function personIdFromEntityId(entityId: string | null | undefined): number | null {
  if (!entityId) return null;
  const { prefix, key } = splitEntityId(entityId);
  if (prefix !== 'person') return null;
  const n = Number.parseInt(key, 10);
  return Number.isFinite(n) ? n : null;
}

/** Numeric FIR id from `fir:210`, or null. */
export function firIdFromEntityId(entityId: string | null | undefined): number | null {
  if (!entityId) return null;
  const { prefix, key } = splitEntityId(entityId);
  if (prefix !== 'fir') return null;
  const n = Number.parseInt(key, 10);
  return Number.isFinite(n) ? n : null;
}

/** Narrative-derived relationship ids are prefixed `narr~` by the backend. */
export function isNarrativeRelationshipId(relationshipId: string | null | undefined): boolean {
  return typeof relationshipId === 'string' && relationshipId.startsWith('narr~');
}
