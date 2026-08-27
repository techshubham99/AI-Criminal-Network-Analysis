"""Evidence-backed integration of narrative relationships into the graph (spec §7).

Hard boundary: **the Phase 2 structured store is read-only here.** Narrative
edges are materialised into a SEPARATE :class:`NetworkXGraphStore` owned by this
integrator, reached through the same abstract ``GraphStore`` interface. Nothing in
this module calls a mutating method on ``app.state.graph.store``, so every Phase 2
count, analytic, and API response is unchanged by Phase 3.

Why a separate store rather than flagged edges in the shared one:

* Phase 2 pins exact node/edge counts and asserts that the set of edge types
  present equals ``ALLOWED_EDGE_TYPES``. Narrative types are a *disjoint* enum
  (``NarrativeEdgeType``), so mixing them in would break that invariant.
* Structured-observed and narrative-derived intelligence must stay
  distinguishable. Separate stores make that structural, not just a flag —
  though the flag (``Edge.is_narrative``) is set as well, along with
  ``source_dataset="fir_text"`` and a per-edge deterministic confidence.

Every proposed edge gets exactly one disposition, and the reason is always
recorded so ``/graph-impact`` can explain each decision:

* ``REJECTED_UNRESOLVED`` — an endpoint did not resolve, or resolved to a node
  that does not exist in the structured graph.
* ``REJECTED_SELF_LOOP`` — same entity on both ends (fir_id 162 in this dataset:
  one person is both complainant and suspect).
* ``REJECTED_LOW_CONFIDENCE`` — below ``settings.nlp_relationship_min_confidence``.
* ``REJECTED_DUPLICATE`` — an equivalent structured edge already exists, or this
  exact narrative edge already exists and this FIR adds no new provenance.
* ``ACCEPTED_MERGED`` — the narrative edge exists and this FIR contributes new
  provenance (a second source record), which is merged into its evidence list.
* ``ACCEPTED_ADDITIVE`` — no equivalent structured edge, but the two endpoints are
  ALREADY connected in the structured graph within
  ``settings.nlp_derivability_max_hops``. New semantics, no new connectivity —
  and the hop distance is recorded so the report cannot overstate the gain.
* ``ACCEPTED_NEW`` — no equivalent edge and no short structured path: genuinely
  new connectivity.

``SAME_RING`` is deliberately NOT consulted when looking for structured
equivalents. It is a ground-truth benchmark overlay, and using it to suppress or
justify narrative edges would leak ground truth into the extraction pipeline.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Optional

from app.config import Settings
from app.graph.model import (
    Edge,
    EdgeType,
    NarrativeEdgeType,
    NARRATIVE_UNDIRECTED_EDGE_TYPES,
    make_narrative_relationship_id,
)
from app.graph.store import GraphStore, NetworkXGraphStore
from app.nlp.models import (
    GraphAddition,
    GraphAdditionStatus,
    NarrativeRelationship,
)

# Structured edge type that a narrative type would DUPLICATE, if one exists.
# MET has no structured equivalent (CO_LOCATED is derived from a shared home
# address, which is not a stated meeting). ASSOCIATED_WITH has none either — the
# only structured "association" is the SAME_RING ground-truth overlay.
STRUCTURED_EQUIVALENT: dict[NarrativeEdgeType, Optional[EdgeType]] = {
    NarrativeEdgeType.REPORTED_AGAINST: EdgeType.REPORTED_AGAINST,
    NarrativeEdgeType.CALLED: EdgeType.CALLED,
    NarrativeEdgeType.LOCATED_AT: EdgeType.LOCATED_AT,
    NarrativeEdgeType.TRANSFERRED_TO: EdgeType.TRANSACTED,
    NarrativeEdgeType.MET: None,
    NarrativeEdgeType.ASSOCIATED_WITH: None,
}

_WEIGHT_NOTE = (
    "narrative edges live in a separate store and are excluded from all Phase 2 "
    "analytics; weight is not an analytic coefficient here"
)


class NarrativeGraphIntegrator:
    """Decides and materialises narrative graph additions.

    ``structured_store`` is only ever read. ``self.store`` is the narrative
    overlay graph this class owns and mutates.
    """

    def __init__(self, structured_store: GraphStore, settings: Settings) -> None:
        self.structured_store = structured_store
        self.settings = settings
        self.store: GraphStore = NetworkXGraphStore()

    # -- public API ----------------------------------------------------------
    def integrate(self, relationships: list[NarrativeRelationship]) -> list[GraphAddition]:
        """Decide + apply the disposition for each relationship, in order."""
        return [self._integrate_one(rel) for rel in relationships]

    def summary(self) -> dict:
        """Summary of the NARRATIVE store, computed here on purpose.

        ``NetworkXGraphStore.graph_summary()`` coerces every edge type back
        through ``EdgeType(...)`` (it is a Phase 2 method for a Phase 2 graph) and
        would raise ``ValueError`` on ``ASSOCIATED_WITH`` / ``MET`` /
        ``TRANSFERRED_TO``. This method iterates the store through the abstract
        interface instead, so the Phase 2 code stays untouched.
        """
        nodes_by_type: dict[str, int] = {}
        for node in self.store.iter_nodes():
            key = node.entity_type.value
            nodes_by_type[key] = nodes_by_type.get(key, 0) + 1
        edges_by_type: dict[str, int] = {}
        confidence_by_type: dict[str, set[float]] = {}
        contributing_firs: set[str] = set()
        for edge in self.store.iter_edges():
            key = edge.relationship_type.value
            edges_by_type[key] = edges_by_type.get(key, 0) + 1
            confidence_by_type.setdefault(key, set()).add(edge.provenance_confidence)
            contributing_firs.update(edge.evidence)
        return {
            "node_count": self.store.node_count(),
            "edge_count": self.store.edge_count(),
            "nodes_by_type": dict(sorted(nodes_by_type.items())),
            "edges_by_type": dict(sorted(edges_by_type.items())),
            "confidence_by_type": {
                k: sorted(v) for k, v in sorted(confidence_by_type.items())
            },
            "contributing_source_records": len(contributing_firs),
            "all_edges_are_narrative": all(
                e.is_narrative and e.source_dataset == "fir_text"
                for e in self.store.iter_edges()
            ),
        }

    # -- decision ------------------------------------------------------------
    def _integrate_one(self, rel: NarrativeRelationship) -> GraphAddition:
        source, target = rel.source_entity_id, rel.target_entity_id

        # 1. Endpoints must resolve, and must exist in the structured graph.
        if source is None or target is None:
            missing = "source" if source is None else "target"
            return GraphAddition(
                relationship=rel,
                status=GraphAdditionStatus.REJECTED_UNRESOLVED,
                reason=f"{missing} entity did not resolve to a graph entity",
            )
        for label, eid in (("source", source), ("target", target)):
            if not self.structured_store.has_node(eid):
                return GraphAddition(
                    relationship=rel,
                    status=GraphAdditionStatus.REJECTED_UNRESOLVED,
                    reason=(
                        f"{label} {eid!r} resolved to a record that is not "
                        "materialised as a node in the graph"
                    ),
                )

        # 2. Self-loops carry no relational information.
        if source == target:
            return GraphAddition(
                relationship=rel,
                status=GraphAdditionStatus.REJECTED_SELF_LOOP,
                reason=(
                    f"both endpoints resolve to {source!r}; this FIR names the same "
                    "person on both sides of the relationship"
                ),
                detail={"entity_id": source},
            )

        # 3. Confidence floor.
        threshold = self.settings.nlp_relationship_min_confidence
        if rel.confidence < threshold:
            return GraphAddition(
                relationship=rel,
                status=GraphAdditionStatus.REJECTED_LOW_CONFIDENCE,
                reason=(
                    f"confidence {rel.confidence} is below the configured minimum "
                    f"of {threshold}"
                ),
                detail={"confidence": rel.confidence, "threshold": threshold},
            )

        # 4. Duplicate of an existing STRUCTURED edge?
        equivalent = STRUCTURED_EQUIVALENT.get(rel.relationship_type)
        if equivalent is not None:
            existing = self._structured_edges(source, target, equivalent, rel.directed)
            if existing:
                return GraphAddition(
                    relationship=rel,
                    status=GraphAdditionStatus.REJECTED_DUPLICATE,
                    reason=(
                        f"a structured {equivalent.value} edge already connects these "
                        "entities; the narrative only restates it, adding no new "
                        "information"
                    ),
                    duplicate_of=existing[0].relationship_id,
                    detail={
                        "structured_edge_type": equivalent.value,
                        "structured_relationship_ids": [e.relationship_id for e in existing],
                    },
                )

        # 5. Already materialised as a narrative edge?
        canonical_source, canonical_target = source, target
        if rel.relationship_type in NARRATIVE_UNDIRECTED_EDGE_TYPES:
            canonical_source, canonical_target = sorted((source, target))
        rel_id = make_narrative_relationship_id(
            rel.relationship_type, canonical_source, canonical_target
        )
        existing_narrative = self.store.get_edge(rel_id)
        if existing_narrative is not None:
            if rel.source_record_id in existing_narrative.evidence:
                return GraphAddition(
                    relationship=rel,
                    status=GraphAdditionStatus.REJECTED_DUPLICATE,
                    reason=(
                        "this narrative edge already exists with the same provenance; "
                        "no new evidence to add"
                    ),
                    duplicate_of=rel_id,
                )
            self._merge_provenance(existing_narrative, rel)
            return GraphAddition(
                relationship=rel,
                status=GraphAdditionStatus.ACCEPTED_MERGED,
                reason=(
                    "narrative edge already existed; this FIR contributes additional "
                    "provenance, which was merged into its evidence list"
                ),
                relationship_id=rel_id,
                detail={"evidence_count": len(existing_narrative.evidence)},
            )

        # 6. New edge. Does it add connectivity, or only semantics?
        hops = self._structured_hop_distance(source, target)
        if hops is None:
            status = GraphAdditionStatus.ACCEPTED_NEW
            reason = (
                "no equivalent structured edge and no structured path within "
                f"{self.settings.nlp_derivability_max_hops} hops; this is new "
                "connectivity contributed by the narrative text"
            )
        else:
            status = GraphAdditionStatus.ACCEPTED_ADDITIVE
            reason = (
                "no equivalent structured edge, but these entities are already "
                f"connected structurally at {hops} hop(s); the narrative adds a new "
                "relationship type and text evidence, not new connectivity"
            )
        self._materialise(rel_id, rel, canonical_source, canonical_target)
        return GraphAddition(
            relationship=rel,
            status=status,
            reason=reason,
            relationship_id=rel_id,
            detail={
                "structured_hop_distance": hops,
                "structured_equivalent_type": equivalent.value if equivalent else None,
            },
        )

    # -- structured-graph reads ----------------------------------------------
    def _structured_edges(
        self, source: str, target: str, edge_type: EdgeType, directed: bool
    ) -> list[Edge]:
        """Structured edges of ``edge_type`` between the endpoints.

        ``GraphStore.edges_between`` is direction-agnostic (it is built for
        "who is connected to whom" queries), so for a DIRECTED narrative type the
        orientation is filtered here — otherwise a narrative A→B would be called a
        duplicate of a structured B→A, which asserts something different.
        """
        edges = self.structured_store.edges_between(
            source, target, edge_types={edge_type}, include_overlay=False
        )
        if directed:
            edges = [
                e
                for e in edges
                if e.source_entity_id == source and e.target_entity_id == target
            ]
        return edges

    def _structured_hop_distance(self, source: str, target: str) -> Optional[int]:
        """Shortest structured path length within the configured hop budget.

        Overlay (ground-truth) edges are excluded, so ``SAME_RING`` can never make
        a narrative edge look redundant.
        """
        paths = self.structured_store.find_paths(
            source,
            target,
            max_length=self.settings.nlp_derivability_max_hops,
            max_paths=1,
            include_overlay=False,
        )
        return len(paths[0]) - 1 if paths else None

    # -- narrative-store writes ---------------------------------------------
    def _materialise(
        self,
        rel_id: str,
        rel: NarrativeRelationship,
        source: str,
        target: str,
    ) -> None:
        """Create the narrative edge, copying endpoint nodes from the structured graph."""
        for eid in (source, target):
            node = self.structured_store.get_node(eid)
            if node is not None:
                # Copy the mutable attribute dict: Node is frozen but its dict is
                # not, and the structured graph must stay byte-identical.
                self.store.add_node(replace(node, attributes=dict(node.attributes)))
        narrative_date = rel.attributes.get("narrative_date")
        self.store.add_edge(
            Edge(
                relationship_id=rel_id,
                source_entity_id=source,
                target_entity_id=target,
                relationship_type=rel.relationship_type,
                directed=rel.directed,
                source_dataset=rel.source_dataset,
                evidence=[rel.source_record_id],
                weight=1.0,
                weight_detail={"note": _WEIGHT_NOTE},
                date_first=narrative_date,
                date_last=narrative_date,
                provenance_confidence=rel.confidence,
                is_overlay=False,
                is_narrative=True,
                attributes={
                    "extraction_method": rel.extraction_method,
                    "evidence_text": rel.evidence_text,
                    "character_start": rel.character_start,
                    "character_end": rel.character_end,
                    "source_mention": rel.source_mention,
                    "target_mention": rel.target_mention,
                    "contributing_firs": [rel.fir_id],
                    **{
                        k: v
                        for k, v in rel.attributes.items()
                        if k != "narrative_date"
                    },
                },
            )
        )

    @staticmethod
    def _merge_provenance(edge: Edge, rel: NarrativeRelationship) -> None:
        """Add a second FIR's evidence to an existing narrative edge."""
        edge.evidence.append(rel.source_record_id)
        firs = edge.attributes.setdefault("contributing_firs", [])
        if rel.fir_id not in firs:
            firs.append(rel.fir_id)
        # Keep the strongest stated confidence; record that it is a maximum.
        if rel.confidence > edge.provenance_confidence:
            edge.provenance_confidence = rel.confidence
        edge.attributes["confidence_basis"] = "max over contributing narratives"
        date = rel.attributes.get("narrative_date")
        if date:
            if edge.date_first is None or date < edge.date_first:
                edge.date_first = date
            if edge.date_last is None or date > edge.date_last:
                edge.date_last = date
