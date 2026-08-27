"""NLP service: builds, caches, and reports the narrative intelligence layer.

This is the single orchestration point for Phase 3. It owns the four stages
(extract → resolve → relate → integrate), caches one :class:`FirAnalysis` per FIR,
maintains a flat search index over the extracted mentions, and computes the
honest evaluation report. The API layer only reads from here — no NLP logic lives
in the routers (spec §1).

Determinism: FIRs are processed in ascending ``fir_id`` and every stage is
rule-based, so a rebuild produces byte-identical output. That matters for the
integration decisions in particular, because "which FIR first created this
narrative edge" is what distinguishes ``ACCEPTED_*`` from ``ACCEPTED_MERGED``.

Honesty (spec §9): the synthetic narratives are templated and mostly RESTATE
structured columns. The evaluation therefore measures how reliably the rules
recover fields we already know, and explicitly separates:

* narrative relationships that duplicate a structured edge (no new information),
* relationships that add a new relationship type between entities that are
  ALREADY connected structurally (new semantics, no new connectivity),
* relationships that add genuinely new connectivity.

None of these numbers are a claim of real-world NLP accuracy.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from app.config import Settings
from app.graph.model import (
    Edge,
    NarrativeEdgeType,
    aadhaar_eid,
    location_eid,
    person_eid,
    phone_eid,
)
from app.graph.store import GraphStore
from app.nlp import normalizer as norm
from app.nlp.extractor import EntityExtractor, spacy_available
from app.nlp.integration import NarrativeGraphIntegrator
from app.nlp.models import (
    CONF_ANCHORED_ONLY,
    CONF_KNOWN_RECORD,
    CONF_REGEX_STRUCTURED,
    CONF_REL_EXPLICIT,
    CONF_REL_HEDGED,
    CONF_REL_SOFT_PLACEMENT,
    CONF_RES_FIR_CONTEXT,
    CONF_RES_IDENTIFIER,
    CONF_RES_UNIQUE_NAME,
    EntityType,
    FirAnalysis,
    GraphAdditionStatus,
    NarrativeRelationship,
    ResolutionStatus,
    ResolvedEntity,
)
from app.nlp.relation_extractor import RelationExtractor
from app.nlp.resolver import EntityResolver

logger = logging.getLogger(__name__)

NLP_PHASE = "3 - FIR Narrative NLP Intelligence"

# Entity types for which the structured dataset provides ground truth, so
# precision/recall/F1 can be computed at all (spec §9). DATE is deliberately
# excluded: the narrative date is not any structured column (it differs from the
# FIR filing date in nearly every record), so there is nothing to score against.
EVALUATED_TYPES: tuple[EntityType, ...] = (
    EntityType.AADHAAR,
    EntityType.LOCATION,
    EntityType.PERSON,
    EntityType.PHONE,
)

_HONESTY_NOTE = (
    "The FIR narratives in this synthetic dataset are generated from a small number "
    "of fixed templates and mostly restate structured columns. These figures measure "
    "how reliably the deterministic rules recover known fields from that template — "
    "they are NOT a measure of real-world NLP accuracy and must not be reported as one."
)


class SearchHit:
    """One entity mention matched by :meth:`NlpService.search` (with the why)."""

    __slots__ = ("fir_id", "resolved", "matched_field")

    def __init__(self, fir_id: int, resolved: ResolvedEntity, matched_field: str) -> None:
        self.fir_id = fir_id
        self.resolved = resolved
        self.matched_field = matched_field


@dataclass(frozen=True)
class SearchResult:
    """A page of search hits plus aggregates over the FULL match set."""

    total: int
    items: list[SearchHit]
    counts_by_type: dict[str, int]
    matched_fir_count: int


class NlpService:
    """Narrative intelligence over the FIR corpus.

    ``structured_store`` is the Phase 2 graph and is only ever READ. Narrative
    edges are written to ``self.integrator.store``, a separate graph.
    """

    def __init__(self, repo, settings: Settings, structured_store: GraphStore) -> None:
        self.repo = repo
        self.settings = settings
        self.extractor = EntityExtractor(repo)
        self.resolver = EntityResolver(repo, settings)
        self.relation_extractor = RelationExtractor(repo)
        self.integrator = NarrativeGraphIntegrator(structured_store, settings)

        self._analyses: dict[int, FirAnalysis] = {}
        self._index: list[SearchHit] = []
        self._built = False

    # -- build ---------------------------------------------------------------
    def build(self) -> None:
        """Analyse every FIR once, in ascending id order (idempotent)."""
        if self._built:
            return
        for fir in sorted(self.repo.firs, key=lambda f: f["fir_id"]):
            self._analyses[fir["fir_id"]] = self._analyze(fir)
        self._index = [
            SearchHit(a.fir_id, r, "")
            for a in self._ordered_analyses()
            for r in a.resolved_entities
        ]
        self._built = True
        logger.info(
            "NLP layer built: %d FIRs, %d entities, %d relationships, %d narrative edges",
            len(self._analyses),
            sum(len(a.resolved_entities) for a in self._analyses.values()),
            sum(len(a.relationships) for a in self._analyses.values()),
            self.integrator.store.edge_count(),
        )

    def _analyze(self, fir: dict) -> FirAnalysis:
        fir_id = fir["fir_id"]
        narrative = norm.normalize_whitespace(fir.get("narrative") or "")
        if not narrative:
            # Empty narrative is a valid, useful answer — not an error (spec §8).
            return FirAnalysis(
                fir_id=fir_id,
                narrative="",
                resolved_entities=[],
                relationships=[],
                graph_additions=[],
            )
        entities = self.extractor.extract(fir_id, narrative)
        resolved = self.resolver.resolve_all(entities)
        relationships = self.relation_extractor.extract(fir_id, narrative, resolved)
        additions = self.integrator.integrate(relationships)
        return FirAnalysis(
            fir_id=fir_id,
            narrative=narrative,
            resolved_entities=resolved,
            relationships=relationships,
            graph_additions=additions,
        )

    def _ordered_analyses(self) -> list[FirAnalysis]:
        return [self._analyses[k] for k in sorted(self._analyses)]

    # -- reads ---------------------------------------------------------------
    @property
    def fir_count(self) -> int:
        return len(self._analyses)

    def has_fir(self, fir_id: int) -> bool:
        return self.repo.get_fir(fir_id) is not None

    def get_analysis(self, fir_id: int) -> Optional[FirAnalysis]:
        """Cached analysis, or ``None`` if no such FIR exists.

        Builds the whole layer on first use if it was constructed cold, rather
        than analysing one FIR in isolation: the integration decisions depend on
        processing order, so a partial build could report a different disposition
        for the same FIR.
        """
        if not self._built:
            self.build()
        return self._analyses.get(fir_id)

    def search(self, query: str, *, offset: int, limit: int) -> "SearchResult":
        """Substring search over extracted mentions. Deterministic order.

        Matches ``raw_text``, ``normalized_value`` or the resolved entity id, and
        reports WHICH field matched so a caller can see why a hit came back. The
        aggregate counts describe ALL matches, not just the returned page.
        """
        needle = norm.normalize_whitespace(query).casefold()
        if not needle:
            return SearchResult(total=0, items=[], counts_by_type={}, matched_fir_count=0)
        hits: list[SearchHit] = []
        for hit in self._index:
            field = self._match_field(hit, needle)
            if field is not None:
                hits.append(SearchHit(hit.fir_id, hit.resolved, field))
        return SearchResult(
            total=len(hits),
            items=hits[offset : offset + limit],
            counts_by_type=_counter(h.resolved.entity.entity_type.value for h in hits),
            matched_fir_count=len({h.fir_id for h in hits}),
        )

    # -- per-FIR reports (shaping helpers; keeps logic out of the routers) ----
    def entity_report(self, analysis: FirAnalysis) -> dict[str, Any]:
        found = {r.entity.entity_type for r in analysis.resolved_entities}
        return {
            "counts_by_type": _counter(
                r.entity.entity_type.value for r in analysis.resolved_entities
            ),
            "resolution_counts": _counter(
                r.resolution.status.value for r in analysis.resolved_entities
            ),
            "absent_entity_types": [t.value for t in EntityType if t not in found],
        }

    def relationship_report(self, analysis: FirAnalysis) -> dict[str, Any]:
        return {
            "counts_by_type": _counter(
                r.relationship_type.value for r in analysis.relationships
            ),
        }

    def narrative_edges_for(self, analysis: FirAnalysis) -> list[Edge]:
        """Narrative-graph edges this FIR contributed (accepted additions only)."""
        out: list[Edge] = []
        seen: set[str] = set()
        for addition in analysis.graph_additions:
            rel_id = addition.relationship_id
            if not addition.accepted or not rel_id or rel_id in seen:
                continue
            edge = self.integrator.store.get_edge(rel_id)
            if edge is not None:
                seen.add(rel_id)
                out.append(edge)
        return sorted(out, key=lambda e: e.relationship_id)

    @staticmethod
    def _match_field(hit: SearchHit, needle: str) -> Optional[str]:
        entity = hit.resolved.entity
        if needle in entity.raw_text.casefold():
            return "raw_text"
        if needle in entity.normalized_value.casefold():
            return "normalized_value"
        matched = hit.resolved.resolution.matched_entity_id
        if matched and needle in matched.casefold():
            return "matched_entity_id"
        return None

    # -- summary -------------------------------------------------------------
    def summary(self) -> dict[str, Any]:
        analyses = self._ordered_analyses()
        entities = [r for a in analyses for r in a.resolved_entities]
        relationships = [r for a in analyses for r in a.relationships]
        additions = [g for a in analyses for g in a.graph_additions]
        return {
            "phase": NLP_PHASE,
            "firs_analyzed": len(analyses),
            "firs_with_narrative": sum(1 for a in analyses if a.narrative),
            "firs_without_narrative": sum(1 for a in analyses if not a.narrative),
            "firs_without_entities": sum(
                1 for a in analyses if a.narrative and not a.resolved_entities
            ),
            "entity_count": len(entities),
            "entities_by_type": _counter(
                r.entity.entity_type.value for r in entities
            ),
            "entities_by_extraction_method": _counter(
                r.entity.extraction_method.value for r in entities
            ),
            "entities_by_confidence": _counter(
                f"{r.entity.confidence}" for r in entities
            ),
            "resolution_by_status": _counter(
                r.resolution.status.value for r in entities
            ),
            "resolution_by_method": _counter(
                r.resolution.resolution_method or "none" for r in entities
            ),
            "unresolved_entities": sum(
                1 for r in entities if r.resolution.status is ResolutionStatus.UNRESOLVED
            ),
            "ambiguous_resolutions": sum(1 for r in entities if r.resolution.ambiguous),
            "relationship_count": len(relationships),
            "relationships_by_type": _counter(
                r.relationship_type.value for r in relationships
            ),
            "relationships_by_confidence": _counter(
                f"{r.confidence}" for r in relationships
            ),
            "graph_additions_by_status": _counter(g.status.value for g in additions),
            "graph_additions_accepted": sum(1 for g in additions if g.accepted),
            "graph_additions_rejected": sum(1 for g in additions if not g.accepted),
            "narrative_graph": self.integrator.summary(),
            "capabilities": {
                "extraction_methods": ["regex", "known_record", "anchored_pattern"],
                "optional_spacy_model_available": spacy_available(),
                "external_model_apis_used": False,
                "supported_entity_types": [t.value for t in EntityType],
                "supported_relationship_types": [t.value for t in NarrativeEdgeType],
            },
            "confidence_semantics": {
                "kind": "deterministic rule-assigned tiers, not learned probabilities",
                "extraction": {
                    "regex_strict_format": CONF_REGEX_STRUCTURED,
                    "known_structured_record": CONF_KNOWN_RECORD,
                    "template_anchor_only": CONF_ANCHORED_ONLY,
                },
                "resolution": {
                    "structured_identifier": CONF_RES_IDENTIFIER,
                    "unique_normalized_match": CONF_RES_UNIQUE_NAME,
                    "fir_context_disambiguation": CONF_RES_FIR_CONTEXT,
                },
                "relationship": {
                    "explicit_trigger": CONF_REL_EXPLICIT,
                    "hedged_or_anaphoric": CONF_REL_HEDGED,
                    "soft_placement": CONF_REL_SOFT_PLACEMENT,
                },
                "thresholds": {
                    "resolution_min_confidence": self.settings.nlp_resolution_min_confidence,
                    "relationship_min_confidence": self.settings.nlp_relationship_min_confidence,
                },
            },
            "evaluation": self.evaluation(),
        }

    # -- evaluation (spec §9) ------------------------------------------------
    def evaluation(self) -> dict[str, Any]:
        analyses = self._ordered_analyses()
        return {
            "methodology": {
                "entity_matching": (
                    "per-FIR set comparison of (entity_type, normalized_value) against "
                    "the FIR's own structured records: complainant Aadhaar, accused "
                    "phone, complainant/accused names, FIR location 'City, State'"
                ),
                "evaluated_entity_types": [t.value for t in EVALUATED_TYPES],
                "excluded_entity_types": {
                    "DATE": (
                        "the narrative date matches no structured column, so no ground "
                        "truth exists; validated by ISO format + span checks instead"
                    ),
                    "MONEY / VEHICLE / ORGANIZATION": (
                        "these never occur in this corpus; the extractor emits none, "
                        "which is reported as an honest zero rather than hidden"
                    ),
                },
                "relationship_matching": (
                    "REPORTED_AGAINST is scored against the structured "
                    "(complainant_id, accused_id) pair. Other narrative types have no "
                    "structured counterpart, so only endpoint agreement with the FIR's "
                    "own records is reported — never accuracy of the assertion itself."
                ),
                "caveat": _HONESTY_NOTE,
            },
            "entity_extraction": self._evaluate_entities(analyses),
            "entity_resolution": self._evaluate_resolution(analyses),
            "date_extraction": self._evaluate_dates(analyses),
            "relationship_extraction": self._evaluate_relationships(analyses),
            "information_gain": self._evaluate_information_gain(analyses),
        }

    def _expected_entities(self, fir: dict) -> dict[tuple[EntityType, str], str]:
        """Ground-truth ``(type, normalized_value) -> expected graph node id``."""
        comp = self.repo.get_person(fir["complainant_id"])
        acc = self.repo.get_person(fir["accused_id"])
        loc = self.repo.get_location(fir["location_id"])
        expected: dict[tuple[EntityType, str], str] = {}
        if comp:
            expected[(EntityType.PERSON, norm.normalize_name(comp["name"]))] = person_eid(
                comp["person_id"]
            )
            expected[(EntityType.AADHAAR, norm.normalize_aadhaar(comp["aadhar"]))] = (
                aadhaar_eid(comp["aadhar"])
            )
        if acc:
            expected[(EntityType.PERSON, norm.normalize_name(acc["name"]))] = person_eid(
                acc["person_id"]
            )
            expected[(EntityType.PHONE, norm.normalize_phone(acc["phone"]))] = phone_eid(
                acc["phone"]
            )
        if loc:
            place = norm.normalize_location(f"{loc['city']}, {loc['state']}")
            expected[(EntityType.LOCATION, place)] = location_eid(loc["location_id"])
        return expected

    def _evaluate_entities(self, analyses: list[FirAnalysis]) -> dict[str, Any]:
        tp: dict[str, int] = {}
        fp: dict[str, int] = {}
        fn: dict[str, int] = {}
        mention_total = 0
        span_mismatches = 0
        for analysis in analyses:
            fir = self.repo.get_fir(analysis.fir_id)
            if fir is None:
                continue
            expected = set(self._expected_entities(fir))
            predicted = set()
            for r in analysis.resolved_entities:
                e = r.entity
                if analysis.narrative[e.character_start : e.character_end] != e.raw_text:
                    span_mismatches += 1
                if e.entity_type in EVALUATED_TYPES:
                    mention_total += 1
                    predicted.add((e.entity_type, e.normalized_value))
            for key in expected & predicted:
                tp[key[0].value] = tp.get(key[0].value, 0) + 1
            for key in predicted - expected:
                fp[key[0].value] = fp.get(key[0].value, 0) + 1
            for key in expected - predicted:
                fn[key[0].value] = fn.get(key[0].value, 0) + 1
        per_type = {
            t.value: _prf(tp.get(t.value, 0), fp.get(t.value, 0), fn.get(t.value, 0))
            for t in EVALUATED_TYPES
        }
        overall = _prf(sum(tp.values()), sum(fp.values()), sum(fn.values()))
        return {
            "per_type": per_type,
            "overall": overall,
            "evaluated_mentions": mention_total,
            "distinct_values_matched": sum(tp.values()),
            "span_mismatches": span_mismatches,
            "entities_dropped_by_validation": len(self.extractor.dropped),
            "zero_occurrence_types": {
                t.value: sum(
                    1
                    for a in analyses
                    for r in a.resolved_entities
                    if r.entity.entity_type is t
                )
                for t in (EntityType.MONEY, EntityType.VEHICLE, EntityType.ORGANIZATION)
            },
        }

    def _evaluate_resolution(self, analyses: list[FirAnalysis]) -> dict[str, Any]:
        checked = correct = incorrect = 0
        unresolved = ambiguous = not_applicable = 0
        examples: list[dict[str, Any]] = []
        for analysis in analyses:
            fir = self.repo.get_fir(analysis.fir_id)
            expected = self._expected_entities(fir) if fir else {}
            for r in analysis.resolved_entities:
                status = r.resolution.status
                if status is ResolutionStatus.UNRESOLVED:
                    unresolved += 1
                elif status is ResolutionStatus.NOT_APPLICABLE:
                    not_applicable += 1
                if r.resolution.ambiguous:
                    ambiguous += 1
                    if len(examples) < 5:
                        examples.append(
                            {
                                "fir_id": analysis.fir_id,
                                "raw_text": r.entity.raw_text,
                                "entity_type": r.entity.entity_type.value,
                                "status": status.value,
                                "candidates": list(r.resolution.candidates),
                                "reason": r.resolution.reason,
                            }
                        )
                key = (r.entity.entity_type, r.entity.normalized_value)
                if key in expected and status is ResolutionStatus.RESOLVED:
                    checked += 1
                    if r.resolution.matched_entity_id == expected[key]:
                        correct += 1
                    else:
                        incorrect += 1
        return {
            "checked_against_structured_truth": checked,
            "correct": correct,
            "incorrect": incorrect,
            "accuracy": round(correct / checked, 4) if checked else None,
            "unresolved": unresolved,
            "ambiguous": ambiguous,
            "not_applicable": not_applicable,
            "ambiguous_examples": examples,
            "note": (
                "names, phone numbers and Aadhaar numbers are unique in this dataset "
                "(0 duplicates), and every narrative city/state matches the FIR's own "
                "location record, so no genuinely ambiguous mention occurs. The "
                "ambiguity branch is exercised by unit tests with synthetic inputs."
            ),
        }

    def _evaluate_dates(self, analyses: list[FirAnalysis]) -> dict[str, Any]:
        extracted = differs = matches_filing = 0
        firs_with_narrative = 0
        for analysis in analyses:
            if not analysis.narrative:
                continue
            firs_with_narrative += 1
            fir = self.repo.get_fir(analysis.fir_id)
            values = [
                r.entity.normalized_value
                for r in analysis.resolved_entities
                if r.entity.entity_type is EntityType.DATE
            ]
            if not values:
                continue
            extracted += 1
            if fir and values[0] == str(fir.get("date")):
                matches_filing += 1
            else:
                differs += 1
        return {
            "firs_with_narrative": firs_with_narrative,
            "firs_with_a_narrative_date": extracted,
            "narrative_date_equals_structured_filing_date": matches_filing,
            "narrative_date_differs_from_filing_date": differs,
            "note": (
                "the narrative date is one field the text genuinely contributes: it is "
                "not the FIR filing date in most records. It is carried as relationship "
                "metadata (narrative_date), not as a graph node."
            ),
        }

    def _evaluate_relationships(self, analyses: list[FirAnalysis]) -> dict[str, Any]:
        by_type: dict[str, int] = {}
        endpoint_agreement: dict[str, dict[str, int]] = {}
        reported_tp = reported_fp = reported_fn = 0
        for analysis in analyses:
            fir = self.repo.get_fir(analysis.fir_id)
            if fir is None:
                continue
            comp_eid = person_eid(fir["complainant_id"])
            acc_eid = person_eid(fir["accused_id"])
            loc_eid = location_eid(fir["location_id"])
            saw_reported = False
            for rel in analysis.relationships:
                key = rel.relationship_type.value
                by_type[key] = by_type.get(key, 0) + 1
                agree = endpoint_agreement.setdefault(key, {"agrees": 0, "disagrees": 0})
                ok = self._endpoints_agree(rel, comp_eid, acc_eid, loc_eid)
                agree["agrees" if ok else "disagrees"] += 1
                if rel.relationship_type is NarrativeEdgeType.REPORTED_AGAINST:
                    saw_reported = True
                    if ok:
                        reported_tp += 1
                    else:
                        reported_fp += 1
            if analysis.narrative and not saw_reported:
                reported_fn += 1
        return {
            "counts_by_type": dict(sorted(by_type.items())),
            "endpoint_agreement_with_fir_record": {
                k: v for k, v in sorted(endpoint_agreement.items())
            },
            "reported_against_scored": _prf(reported_tp, reported_fp, reported_fn),
            "relationships_dropped_by_validation": len(self.relation_extractor.dropped),
            "co_occurrence_only_relationships": 0,
            "note": (
                "no relationship is emitted from co-occurrence alone: every one requires "
                "an explicit trigger phrase in the sentence plus role-bound endpoints. "
                "'endpoint agreement' checks that the two ends are the FIR's own "
                "complainant/accused/location records — it does not and cannot verify "
                "that the narrative's claim is true."
            ),
        }

    @staticmethod
    def _endpoints_agree(
        rel: NarrativeRelationship, comp_eid: str, acc_eid: str, loc_eid: str
    ) -> bool:
        known = {comp_eid, acc_eid, loc_eid}
        if rel.relationship_type is NarrativeEdgeType.REPORTED_AGAINST:
            return rel.source_entity_id == comp_eid and rel.target_entity_id == acc_eid
        if rel.relationship_type is NarrativeEdgeType.LOCATED_AT:
            return rel.source_entity_id in {comp_eid, acc_eid} and (
                rel.target_entity_id == loc_eid
            )
        return rel.source_entity_id in known and rel.target_entity_id in known

    def _evaluate_information_gain(self, analyses: list[FirAnalysis]) -> dict[str, Any]:
        additions = [g for a in analyses for g in a.graph_additions]
        by_status = _counter(g.status.value for g in additions)
        restates = by_status.get(GraphAdditionStatus.REJECTED_DUPLICATE.value, 0)
        additive = by_status.get(GraphAdditionStatus.ACCEPTED_ADDITIVE.value, 0)
        brand_new = by_status.get(GraphAdditionStatus.ACCEPTED_NEW.value, 0)
        merged = by_status.get(GraphAdditionStatus.ACCEPTED_MERGED.value, 0)
        hop_hist: dict[str, int] = {}
        for g in additions:
            hops = g.detail.get("structured_hop_distance")
            if hops is not None:
                hop_hist[str(hops)] = hop_hist.get(str(hops), 0) + 1
        return {
            "proposed_relationships": len(additions),
            "by_status": by_status,
            "restates_existing_structured_edge": restates,
            "new_edge_but_no_new_connectivity": additive,
            "new_connectivity": brand_new,
            "merged_additional_provenance": merged,
            "structured_hop_distance_of_accepted_edges": dict(sorted(hop_hist.items())),
            "narrative_edges_materialized": self.integrator.store.edge_count(),
            "structured_graph_mutated": False,
            "note": (
                "'new_edge_but_no_new_connectivity' is the honest count the spec asks "
                "for: the narrative asserts a relationship type the structured data "
                "does not have, but the two entities were already connected within "
                f"{self.settings.nlp_derivability_max_hops} hops, so no investigative "
                "link is genuinely discovered. Ground-truth SAME_RING overlay edges are "
                "excluded from every check so no ground truth leaks into this accounting."
            ),
        }

    # -- graph impact (spec §8) ---------------------------------------------
    def graph_impact(self, analysis: FirAnalysis) -> dict[str, Any]:
        """Accept/reject accounting for one FIR, with a reason for every decision."""
        additions = analysis.graph_additions
        accepted = [g for g in additions if g.accepted]
        rejected = [g for g in additions if not g.accepted]
        return {
            "extracted_entity_count": len(analysis.resolved_entities),
            "resolved_entity_count": sum(
                1
                for r in analysis.resolved_entities
                if r.resolution.status is ResolutionStatus.RESOLVED
            ),
            "unresolved_entity_count": sum(
                1
                for r in analysis.resolved_entities
                if r.resolution.status is ResolutionStatus.UNRESOLVED
            ),
            "ambiguous_entity_count": sum(
                1 for r in analysis.resolved_entities if r.resolution.ambiguous
            ),
            "validated_relationship_count": len(analysis.relationships),
            "proposed_count": len(additions),
            "accepted_count": len(accepted),
            "rejected_count": len(rejected),
            "by_status": _counter(g.status.value for g in additions),
            "structured_graph_mutated": False,
        }


def _counter(values: Iterable[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return dict(sorted(out.items()))


def _prf(tp: int, fp: int, fn: int) -> dict[str, Any]:
    """Precision / recall / F1 with explicit ``None`` when undefined."""
    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    if precision and recall and (precision + recall):
        f1 = 2 * precision * recall / (precision + recall)
    else:
        f1 = None if precision is None or recall is None else 0.0
    return {
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": round(precision, 4) if precision is not None else None,
        "recall": round(recall, 4) if recall is not None else None,
        "f1": round(f1, 4) if f1 is not None else None,
    }


def build_nlp_service(
    repo,
    settings: Settings,
    structured_store: GraphStore,
    *,
    warm: bool = True,
) -> NlpService:
    """Construct the NLP service (mirrors ``build_graph_service``)."""
    service = NlpService(repo, settings, structured_store)
    if warm:
        service.build()
    return service
