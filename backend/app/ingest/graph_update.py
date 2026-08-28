"""Incremental graph updates for accepted records (spec §9).

The graph is *edited*, never rebuilt: inserting one call touches one aggregate
edge (and possibly one tower node), not 500 persons and 2 000 calls. Three
properties are preserved deliberately, because they are what make the edit
indistinguishable from a rebuild:

* **Aggregation.** Phase 2 folds every call between one ordered pair into a
  single ``CALLED`` edge carrying ``weight=count`` and
  ``weight_detail={count, total_duration_sec}``. A live call therefore *merges
  into* that edge — one more piece of evidence, a higher count, a wider date
  range — instead of adding a parallel edge. This is what makes a resubmitted
  record incapable of double-counting (spec §2).
* **Provenance.** Every live row contributes its own ``table:pk`` evidence id,
  keeping the existing "one evidence id per observation" invariant, and the
  submission's ``record_id`` is recorded in ``attributes.ingest_record_ids`` so
  an edge can always be traced back to the submission that changed it.
* **The structured / narrative split.** Nothing here writes to the Phase 3
  narrative overlay, and nothing here writes ``SAME_RING``: the ground-truth
  overlay is not observable intelligence and live data never fabricates it.

A self-referencing observation (a person calling their own number) is written as
a self-loop — it is real evidence — and the Phase 2 projections already skip
self-loops, so it stays out of centrality and out of Phase 4 scoring exactly as
before.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from app.graph.model import (
    Edge,
    EdgeType,
    Node,
    NodeType,
    fir_eid,
    location_eid,
    make_relationship_id,
    person_eid,
    source_record_id,
    tower_eid,
)
from app.graph.store import GraphStore


@dataclass
class GraphChange:
    """What one accepted record did to the graph."""

    nodes_added: list[str] = field(default_factory=list)
    edges_added: list[str] = field(default_factory=list)
    edges_updated: list[str] = field(default_factory=list)

    @property
    def touched_graph(self) -> bool:
        return bool(self.nodes_added or self.edges_added or self.edges_updated)

    def as_dict(self) -> dict[str, Any]:
        return {
            "nodes_added": list(self.nodes_added),
            "edges_added": list(self.edges_added),
            "edges_updated": list(self.edges_updated),
        }


def _lo(current: Optional[str], value: Optional[str]) -> Optional[str]:
    if value is None:
        return current
    return value if current is None or value < current else current


def _hi(current: Optional[str], value: Optional[str]) -> Optional[str]:
    if value is None:
        return current
    return value if current is None or value > current else current


class GraphUpdater:
    """Applies one accepted record to an existing :class:`GraphStore`."""

    def __init__(self, store: GraphStore) -> None:
        self.store = store
        self.change = GraphChange()

    # -- nodes -------------------------------------------------------------
    def ensure_tower(self, tower_id: int) -> str:
        entity_id = tower_eid(int(tower_id))
        if not self.store.has_node(entity_id):
            self.store.add_node(
                Node(
                    entity_id=entity_id,
                    entity_type=NodeType.CELL_TOWER,
                    label=f"Tower {int(tower_id)}",
                    source_dataset="calls",
                    source_record_id=source_record_id("calls.cell_tower_id", int(tower_id)),
                )
            )
            self.change.nodes_added.append(entity_id)
        return entity_id

    def add_fir_node(self, fir_row: dict, record_id: str) -> str:
        """Materialise the FIR node for an accepted live FIR row."""
        fid = int(fir_row["fir_id"])
        entity_id = fir_eid(fid)
        if not self.store.has_node(entity_id):
            self.store.add_node(
                Node(
                    entity_id=entity_id,
                    entity_type=NodeType.FIR,
                    label=f"FIR {fid} ({fir_row['date']})",
                    source_dataset="firs",
                    source_record_id=source_record_id("firs", fid),
                    attributes={
                        "date": fir_row["date"],
                        "location_id": fir_row["location_id"],
                        "origin": "ingest",
                        "ingest_record_id": record_id,
                    },
                )
            )
            self.change.nodes_added.append(entity_id)
        return entity_id

    # -- the aggregate upsert ----------------------------------------------
    def _upsert(
        self,
        edge_type: EdgeType,
        source: str,
        target: str,
        *,
        source_dataset: str,
        evidence_id: str,
        record_id: str,
        when: Optional[str],
        directed: bool = True,
        role: Optional[str] = None,
        counters: Optional[dict[str, float]] = None,
        count_key: str = "count",
        attributes: Optional[dict[str, Any]] = None,
    ) -> tuple[str, bool]:
        """Merge one observation into the aggregate edge for this pair.

        Returns ``(relationship_id, is_new_edge)``. Re-adding an edge through the
        store also refreshes the underlying graph's cached weight and invalidates
        the path projections, which is why a fresh :class:`Edge` is written back
        rather than the existing one being mutated in place.
        """
        rid = make_relationship_id(edge_type, source, target, role=role)
        existing = self.store.get_edge(rid)
        counters = counters or {}

        if existing is None:
            detail: dict[str, Any] = {count_key: 1}
            for key, value in counters.items():
                detail[key] = value
            edge = Edge(
                relationship_id=rid,
                source_entity_id=source,
                target_entity_id=target,
                relationship_type=edge_type,
                directed=directed,
                source_dataset=source_dataset,
                evidence=[evidence_id],
                weight=1.0,
                weight_detail=detail,
                date_first=when,
                date_last=when,
                attributes={**(attributes or {}), "ingest_record_ids": [record_id]},
            )
            self.store.add_edge(edge)
            self.change.edges_added.append(rid)
            return rid, True

        detail = dict(existing.weight_detail)
        detail[count_key] = int(detail.get(count_key, len(existing.evidence) or 1)) + 1
        for key, value in counters.items():
            merged = float(detail.get(key, 0.0)) + float(value)
            detail[key] = round(merged, 2)
        evidence = list(existing.evidence)
        if evidence_id not in evidence:
            evidence.append(evidence_id)
        attrs = dict(existing.attributes)
        if attributes:
            attrs.update(attributes)
        record_ids = list(attrs.get("ingest_record_ids") or [])
        if record_id not in record_ids:
            record_ids.append(record_id)
        attrs["ingest_record_ids"] = record_ids

        self.store.add_edge(
            Edge(
                relationship_id=rid,
                source_entity_id=existing.source_entity_id,
                target_entity_id=existing.target_entity_id,
                relationship_type=existing.relationship_type,
                directed=existing.directed,
                source_dataset=existing.source_dataset,
                evidence=evidence,
                weight=float(detail[count_key]),
                weight_detail=detail,
                date_first=_lo(existing.date_first, when),
                date_last=_hi(existing.date_last, when),
                provenance_confidence=existing.provenance_confidence,
                is_overlay=existing.is_overlay,
                is_narrative=existing.is_narrative,
                attributes=attrs,
            )
        )
        self.change.edges_updated.append(rid)
        return rid, False

    # -- per-source-type edges ---------------------------------------------
    def called(self, call_row: dict, record_id: str) -> tuple[str, bool]:
        return self._upsert(
            EdgeType.CALLED,
            person_eid(int(call_row["caller_id"])),
            person_eid(int(call_row["callee_id"])),
            source_dataset="calls",
            evidence_id=source_record_id("calls", call_row["call_id"]),
            record_id=record_id,
            when=call_row["start_time"],
            counters={"total_duration_sec": float(call_row["duration_sec"])},
        )

    def used_tower(self, call_row: dict, record_id: str) -> Optional[tuple[str, bool]]:
        tower = call_row.get("cell_tower_id")
        if tower is None:
            return None
        target = self.ensure_tower(int(tower))
        return self._upsert(
            EdgeType.USED_TOWER,
            person_eid(int(call_row["caller_id"])),
            target,
            source_dataset="calls",
            evidence_id=source_record_id("calls", call_row["call_id"]),
            record_id=record_id,
            when=call_row["start_time"],
        )

    def transacted(self, txn_row: dict, record_id: str) -> tuple[str, bool]:
        return self._upsert(
            EdgeType.TRANSACTED,
            person_eid(int(txn_row["sender_id"])),
            person_eid(int(txn_row["receiver_id"])),
            source_dataset="transactions",
            evidence_id=source_record_id("transactions", txn_row["txn_id"]),
            record_id=record_id,
            when=txn_row["txn_time"],
            counters={"total_amount_inr": float(txn_row["amount_inr"])},
        )

    def named_in_fir(
        self, person_id: int, fir_row: dict, role: str, record_id: str
    ) -> tuple[str, bool]:
        return self._upsert(
            EdgeType.NAMED_IN_FIR,
            person_eid(int(person_id)),
            fir_eid(int(fir_row["fir_id"])),
            source_dataset="firs",
            evidence_id=source_record_id("firs", fir_row["fir_id"]),
            record_id=record_id,
            when=fir_row["date"],
            role=role,
            attributes={"role": role, "fir_date": fir_row["date"]},
        )

    def reported_against(
        self, complainant_id: int, accused_id: int, fir_row: dict, record_id: str
    ) -> tuple[str, bool]:
        return self._upsert(
            EdgeType.REPORTED_AGAINST,
            person_eid(int(complainant_id)),
            person_eid(int(accused_id)),
            source_dataset="firs",
            evidence_id=source_record_id("firs", fir_row["fir_id"]),
            record_id=record_id,
            when=fir_row["date"],
            count_key="fir_count",
        )

    def fir_located_at(self, fir_row: dict, record_id: str) -> tuple[str, bool]:
        return self._upsert(
            EdgeType.LOCATED_AT,
            fir_eid(int(fir_row["fir_id"])),
            location_eid(int(fir_row["location_id"])),
            source_dataset="firs",
            evidence_id=source_record_id("firs", fir_row["fir_id"]),
            record_id=record_id,
            when=fir_row["date"],
            attributes={"subject_type": "FIR"},
        )

    def observed_at(
        self, person_id: int, location_id: int, observed_at: Optional[str], record_id: str
    ) -> tuple[str, bool]:
        """A reported sighting of a person at a location.

        Carries ``role="observed"`` in its relationship id so it stays a
        *separate* edge from the person's recorded home ``LOCATED_AT``: an
        observation is evidence of presence, not a correction of the address on
        file, and the dataset-derived edge is left byte-for-byte alone.
        """
        return self._upsert(
            EdgeType.LOCATED_AT,
            person_eid(int(person_id)),
            location_eid(int(location_id)),
            source_dataset="ingest",
            evidence_id=source_record_id("ingest", record_id),
            record_id=record_id,
            when=observed_at,
            role="observed",
            attributes={"subject_type": "PERSON", "origin": "ingest"},
        )
