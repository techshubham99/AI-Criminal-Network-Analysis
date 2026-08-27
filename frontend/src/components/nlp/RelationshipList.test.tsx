/**
 * RelationshipList — §6's "extracted relationships" and their provenance, from
 * the recorded `/nlp/firs/79/relationships` response.
 *
 * Two things are being defended here.
 *
 * First, that nothing on this list pretends to be an observation. Every card is
 * an assertion FIR prose makes, admitted only because an explicit trigger phrase
 * fired a named rule with role-bound endpoints — so every card must carry the
 * NARRATIVE-DERIVED tag, the rule name, and the quoted sentence with offsets.
 *
 * Second, the provenance asymmetry that is easy to get backwards elsewhere in
 * this app: a narrative `RelationshipOut` DOES carry a scalar `source_record_id`
 * (the FIR row whose text was read), whereas a structured `EdgeOut` does not and
 * cites an `evidence` array instead. This suite asserts the field is present here.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RelationshipOut } from '@/types/api';
import { fixtures, installFetch, renderWithRouter } from '@/test/helpers';

import { RelationshipList } from './RelationshipList';

const recorded = fixtures.firRelationships79 as unknown as {
  relationship_count: number;
  relationships: RelationshipOut[];
};
const relationships = recorded.relationships;

const reportedAgainst = relationships.find((r) => r.relationship_type === 'REPORTED_AGAINST')!;
const locatedAt = relationships.find((r) => r.relationship_type === 'LOCATED_AT')!;

/** The card whose relationship-type badge reads `relationshipType`. */
function card(relationshipType: string): HTMLElement {
  const badge = screen.getByText(relationshipType);
  const article = badge.closest('article');
  if (!article) throw new Error(`no card for ${relationshipType}`);
  return article as HTMLElement;
}

/** The <dd> inside `scope` belonging to the <dt> labelled exactly `label`. */
function fieldIn(scope: HTMLElement, label: string): HTMLElement {
  const dts = Array.from(scope.querySelectorAll('dt'));
  const dt = dts.find((el) => el.querySelector('span')?.textContent?.trim() === label);
  if (!dt) {
    const seen = dts.map((el) => el.querySelector('span')?.textContent?.trim()).join(' | ');
    throw new Error(`no field labelled "${label}". Present: ${seen}`);
  }
  const dd = dt.parentElement?.querySelector('dd');
  if (!dd) throw new Error(`field "${label}" has no value cell`);
  return dd as HTMLElement;
}

const labelsIn = (scope: HTMLElement) =>
  Array.from(scope.querySelectorAll('dt')).map((el) =>
    el.querySelector('span')?.textContent?.trim(),
  );

function renderList(items: RelationshipOut[] = relationships) {
  return renderWithRouter(<RelationshipList relationships={items} />);
}

describe('RelationshipList — the recorded assertions', () => {
  it('needs no backend of its own', async () => {
    const { calls } = installFetch();
    renderList();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('renders one card per relationship, and the response agrees on the count', () => {
    renderList();
    expect(document.querySelectorAll('article')).toHaveLength(relationships.length);
    expect(relationships).toHaveLength(recorded.relationship_count);
  });

  it('tags every card as narrative-derived, because none of them is an observation', () => {
    renderList();
    // The compact tag reads NARRATIVE; its tooltip carries the full statement.
    expect(screen.getAllByText('NARRATIVE')).toHaveLength(relationships.length);
    expect(
      screen.getAllByText(/never merged into the structured graph/i).length,
    ).toBeGreaterThan(0);
  });

  it('reads the assertion in the sentence’s own words', () => {
    renderList();
    const scope = card('REPORTED_AGAINST');
    // Suhani Chand -> Ojas Kuruvilla. The mentions, not the ids.
    expect(within(scope).getAllByText(reportedAgainst.source_mention).length).toBeGreaterThan(0);
    expect(within(scope).getAllByText(reportedAgainst.target_mention).length).toBeGreaterThan(0);
  });

  it('states that a recorded edge is directed', () => {
    renderList();
    expect(within(card('REPORTED_AGAINST')).getByText('Directed')).toBeInTheDocument();
  });

  it('states the undirected case too', () => {
    // Neither recorded relationship is undirected, so the other branch is proved
    // against the same record with its own flag flipped.
    renderList([{ ...locatedAt, directed: false }]);
    expect(screen.getByText('Undirected')).toBeInTheDocument();
  });

  it('prints the rule-assigned confidence tier as a decimal', () => {
    renderList();
    expect(within(card('REPORTED_AGAINST')).getByText('1.00')).toBeInTheDocument();
    // A sighting placement is a weaker rule, and the backend says 0.7.
    expect(within(card('LOCATED_AT')).getByText('0.70')).toBeInTheDocument();
  });
});

describe('RelationshipList — the two endpoints', () => {
  it('shows the graph id each mention resolved to', () => {
    renderList();
    const scope = card('LOCATED_AT');
    expect(within(scope).getByText('Source')).toBeInTheDocument();
    expect(within(scope).getByText('Target')).toBeInTheDocument();
    expect(within(scope).getByText(locatedAt.source_entity_id as string)).toBeInTheDocument();
    expect(within(scope).getByText(locatedAt.target_entity_id as string)).toBeInTheDocument();
    expect(within(scope).getAllByText('Resolved')).toHaveLength(2);
  });

  it('says outright when a mention could not be tied to any entity', () => {
    // The recorded response resolved both sides. An unresolved side is the case
    // the UI must not hide, so it is proved with the same record's flag cleared.
    const halfResolved: RelationshipOut = {
      ...locatedAt,
      target_resolved: false,
      target_entity_id: null,
    };
    renderList([halfResolved]);

    expect(screen.getByText('Unresolved')).toBeInTheDocument();
    expect(
      screen.getByText(/could not be tied to a known entity, so it has no graph id/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('location:178')).not.toBeInTheDocument();
  });

  it('quotes the mention text on each endpoint', () => {
    renderList([locatedAt]);
    // "the scene" is an anaphoric mention the rule bound to a location record.
    expect(screen.getByText(`“${locatedAt.target_mention}”`)).toBeInTheDocument();
  });
});

describe('RelationshipList — evidence and provenance', () => {
  it('quotes the narrative span verbatim, with its character offsets', () => {
    renderList([reportedAgainst]);
    expect(screen.getByText('Quoted evidence')).toBeInTheDocument();
    expect(screen.getByText(reportedAgainst.evidence_text)).toBeInTheDocument();
    expect(
      screen.getByText(
        `characters ${reportedAgainst.character_start}–${reportedAgainst.character_end}`,
      ),
    ).toBeInTheDocument();
  });

  it('promotes the trigger phrase, because without it nothing is asserted', () => {
    renderList();
    // "Suspect" fired the complainant/accused rule; "was seen near" fired the
    // sighting-placement rule.
    expect(within(card('REPORTED_AGAINST')).getByText('“Suspect”')).toBeInTheDocument();
    expect(within(card('LOCATED_AT')).getByText('“was seen near”')).toBeInTheDocument();
    expect(
      screen.getAllByText(/Without an explicit trigger like this, the relationship is not asserted/i)
        .length,
    ).toBeGreaterThan(0);
  });

  it('names the deterministic rule that fired, and denies using a model API', () => {
    renderList();
    expect(fieldIn(card('REPORTED_AGAINST'), 'Extraction rule')).toHaveTextContent(
      'Complainant reported suspect',
    );
    expect(fieldIn(card('LOCATED_AT'), 'Extraction rule')).toHaveTextContent('Sighting placement');
    expect(
      screen.getAllByText(/No external model API is involved/i).length,
    ).toBeGreaterThan(0);
  });

  it('carries a scalar source record id — the field a structured edge lacks', () => {
    renderList([reportedAgainst]);
    const scope = card('REPORTED_AGAINST');
    expect(fieldIn(scope, 'Source dataset')).toHaveTextContent('fir_text');
    expect(fieldIn(scope, 'Source record ID')).toHaveTextContent('firs:79');
    expect(fieldIn(scope, 'FIR')).toHaveTextContent('fir:79');
    expect(
      screen.getByText(/the FIR row whose narrative was read/i),
    ).toBeInTheDocument();
  });

  it('lists the rest of the rule’s metadata without repeating the trigger', () => {
    renderList([reportedAgainst]);
    const present = labelsIn(card('REPORTED_AGAINST'));
    // Everything the backend sent is shown …
    expect(present).toContain('Complainant role evidence');
    expect(present).toContain('Accused role evidence');
    expect(present).toContain('Narrative date');
    // … except trigger_text, which already has its own block above.
    expect(present).not.toContain('Trigger text');
  });

  it('shows a rule attribute that only one of the two records has', () => {
    renderList([locatedAt]);
    const present = labelsIn(card('LOCATED_AT'));
    expect(present).toContain('Proximity');
    expect(present).toContain('Target bound via');
    expect(fieldIn(card('LOCATED_AT'), 'Target bound via')).toHaveTextContent('role_anaphora');
  });
});

describe('RelationshipList — nothing asserted', () => {
  it('says co-occurrence is deliberately not treated as a relationship', () => {
    renderList([]);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText(/No relationships asserted by this narrative/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Co-occurrence in the same FIR is deliberately not treated as a relationship/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/an empty list here is the correct answer rather than a gap/i),
    ).toBeInTheDocument();
    expect(document.querySelector('article')).toBeNull();
  });
});
