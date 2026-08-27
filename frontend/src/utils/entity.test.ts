/**
 * The entity vocabulary and — more importantly — the id bridge.
 *
 * `personIdFromEntityId` is the single point where the backend's two id forms
 * meet: responses speak `person:445`, but path parameters parse an integer. A
 * regression here is a 422 on every network view, so it is pinned in both
 * directions, including the cases that must return null rather than a plausible
 * wrong number.
 */
import { describe, expect, it } from 'vitest';

import {
  ENTITY_TYPE_STYLES,
  RELATIONSHIP_STYLES,
  UNKNOWN_ENTITY_STYLE,
  UNKNOWN_RELATIONSHIP_STYLE,
  entityColor,
  entityStyle,
  firIdFromEntityId,
  isNarrativeRelationshipId,
  personIdFromEntityId,
  relationshipStyle,
  splitEntityId,
} from './entity';
import { fixtures } from '@/test/helpers';

describe('splitEntityId', () => {
  it('splits on the FIRST colon, so a phone id keeps its own punctuation', () => {
    expect(splitEntityId('phone:+91-7804841598')).toEqual({
      prefix: 'phone',
      key: '+91-7804841598',
    });
  });

  it('handles the ordinary numeric case', () => {
    expect(splitEntityId('person:445')).toEqual({ prefix: 'person', key: '445' });
  });

  it('treats an unprefixed string as a bare key rather than guessing a type', () => {
    expect(splitEntityId('445')).toEqual({ prefix: '', key: '445' });
  });
});

describe('personIdFromEntityId', () => {
  it('yields the numeric row id a path parameter needs', () => {
    expect(personIdFromEntityId('person:445')).toBe(445);
  });

  it('refuses every non-person prefix instead of returning its number', () => {
    // `location:23` -> 23 would silently request /graph/persons/23: a real
    // person, the wrong one, and no error anywhere. Null is the only safe answer.
    expect(personIdFromEntityId('location:23')).toBeNull();
    expect(personIdFromEntityId('fir:210')).toBeNull();
    expect(personIdFromEntityId('tower:2404')).toBeNull();
    expect(personIdFromEntityId('phone:+91-7804841598')).toBeNull();
  });

  it('refuses an unprefixed id, null and undefined', () => {
    expect(personIdFromEntityId('445')).toBeNull();
    expect(personIdFromEntityId(null)).toBeNull();
    expect(personIdFromEntityId(undefined)).toBeNull();
    expect(personIdFromEntityId('')).toBeNull();
  });

  it('refuses a non-numeric key', () => {
    expect(personIdFromEntityId('person:abc')).toBeNull();
  });
});

describe('firIdFromEntityId', () => {
  it('yields the numeric FIR id', () => {
    expect(firIdFromEntityId('fir:210')).toBe(210);
  });

  it('refuses a person id', () => {
    expect(firIdFromEntityId('person:445')).toBeNull();
  });
});

describe('isNarrativeRelationshipId', () => {
  it('recognises the backend narr~ prefix, which means "do not ask for a structured record"', () => {
    expect(isNarrativeRelationshipId('narr~ASSOCIATED_WITH~person:445~person:114')).toBe(true);
  });

  it('leaves structured relationship ids alone', () => {
    expect(isNarrativeRelationshipId('CALLED~person:141~person:189')).toBe(false);
    expect(isNarrativeRelationshipId(null)).toBe(false);
  });
});

describe('entityStyle', () => {
  it('covers every node type the graph actually materialises', () => {
    for (const type of ['PERSON', 'PHONE', 'AADHAAR', 'LOCATION', 'FIR', 'CELL_TOWER']) {
      expect(ENTITY_TYPE_STYLES[type]).toBeDefined();
    }
  });

  it('has no TRANSACTION entry, because money movement is an edge not a node', () => {
    expect(ENTITY_TYPE_STYLES.TRANSACTION).toBeUndefined();
  });

  it('falls back visibly rather than crashing on an unknown type', () => {
    expect(entityStyle('SPACESHIP')).toBe(UNKNOWN_ENTITY_STYLE);
    expect(entityStyle(null)).toBe(UNKNOWN_ENTITY_STYLE);
    expect(entityStyle(undefined)).toBe(UNKNOWN_ENTITY_STYLE);
  });

  it('is case-insensitive', () => {
    expect(entityStyle('person')).toBe(ENTITY_TYPE_STYLES.PERSON);
  });

  it('gives every style a hex colour usable by both Cytoscape and a style prop', () => {
    for (const [type, style] of Object.entries(ENTITY_TYPE_STYLES)) {
      expect(style.color, type).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.hint.length, type).toBeGreaterThan(10);
    }
    expect(entityColor('PERSON')).toBe(ENTITY_TYPE_STYLES.PERSON.color);
  });

  it('styles every entity_type present in the recorded responses', () => {
    const seen = new Set<string>();
    for (const node of fixtures.network445Depth2.nodes as Array<{ entity_type: string }>) {
      seen.add(node.entity_type);
    }
    for (const node of fixtures.graphSearchOjas.results as Array<{ entity_type: string }>) {
      seen.add(node.entity_type);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const type of seen) {
      expect(entityStyle(type), type).not.toBe(UNKNOWN_ENTITY_STYLE);
    }
  });
});

describe('relationshipStyle', () => {
  it('dashes exactly the relationships that are not a direct observation', () => {
    // Derived, synthetic, or asserted only by narrative text.
    for (const type of ['CO_LOCATED', 'SAME_RING', 'ASSOCIATED_WITH', 'MET', 'TRANSFERRED_TO']) {
      expect(relationshipStyle(type).dashed, type).toBe(true);
    }
    // Observed in a dataset row.
    for (const type of ['CALLED', 'TRANSACTED', 'OWNS_PHONE', 'NAMED_IN_FIR', 'USED_TOWER']) {
      expect(relationshipStyle(type).dashed, type).toBe(false);
    }
  });

  it('says in words that SAME_RING is ground truth rather than evidence', () => {
    expect(RELATIONSHIP_STYLES.SAME_RING.hint).toMatch(/GROUND TRUTH/);
  });

  it('never calls an allegation a finding of guilt', () => {
    expect(RELATIONSHIP_STYLES.REPORTED_AGAINST.hint).toMatch(/not a finding of guilt/i);
  });

  it('falls back for an unknown type', () => {
    expect(relationshipStyle('TELEPATHY')).toBe(UNKNOWN_RELATIONSHIP_STYLE);
    expect(relationshipStyle(null)).toBe(UNKNOWN_RELATIONSHIP_STYLE);
  });

  it('styles every relationship_type present in the recorded network', () => {
    const seen = new Set<string>();
    for (const edge of fixtures.network445Depth2.edges as Array<{ relationship_type: string }>) {
      seen.add(edge.relationship_type);
    }
    for (const type of seen) {
      expect(relationshipStyle(type), type).not.toBe(UNKNOWN_RELATIONSHIP_STYLE);
    }
  });
});
