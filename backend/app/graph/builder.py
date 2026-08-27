"""Deterministic graph construction service.

``GraphBuilder`` turns the Phase 1 :class:`DatasetRepository` into a typed,
evidence-backed graph inside a :class:`GraphStore`. It is deterministic: the
same dataset always yields byte-for-byte the same nodes and edges (all source
rows are iterated in sorted primary-key order and all derived pairs are sorted).

Only the relationship types verified in ``docs/phase2_preflight.md`` are emitted,
every edge carries its ``source_record_id`` evidence, and every edge's
existence-confidence is a deterministic ``1.0`` (never a fabricated model
confidence). Self-references are retained as self-loops in this full evidence
graph and are excluded later, in the analytics projections only.

Graph-building logic lives here in the service layer — never in API routers.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Optional

from app.config import Settings
from app.graph.model import (
    Edge,
    EdgeType,
    Node,
    NodeType,
    aadhaar_eid,
    fir_eid,
    location_eid,
    make_relationship_id,
    person_eid,
    phone_eid,
    source_record_id,
    tower_eid,
)
from app.graph.store import GraphStore, NetworkXGraphStore
from app.repositories.dataset import DatasetRepository

logger = logging.getLogger("app.graph.builder")


def _minmax(current_lo: Optional[str], current_hi: Optional[str], value: str):
    lo = value if current_lo is None or value < current_lo else current_lo
    hi = value if current_hi is None or value > current_hi else current_hi
    return lo, hi


class GraphBuilder:
    def __init__(self, repo: DatasetRepository, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings
        self.store: GraphStore = NetworkXGraphStore()
        self.stats: dict[str, Any] = {}

    def build(self) -> GraphStore:
        self._add_nodes()
        self._add_identity_edges()
        self._add_located_at()
        self._add_called()
        self._add_transacted()
        self._add_fir_edges()
        self._add_co_located()
        self._add_used_tower()
        self._add_same_ring_overlay()
        self.stats["graph_summary"] = self.store.graph_summary()
        logger.info(
            "Graph built: %d nodes, %d edges (%d observed, %d overlay), %d self-loops",
            self.store.node_count(),
            self.store.edge_count(),
            self.stats["graph_summary"]["observed_edge_count"],
            self.stats["graph_summary"]["overlay_edge_count"],
            self.stats["graph_summary"]["self_loops"],
        )
        return self.store

    # -- nodes -------------------------------------------------------------
    def _add_nodes(self) -> None:
        persons = sorted(self.repo.persons, key=lambda p: p["person_id"])
        for p in persons:
            pid = p["person_id"]
            self.store.add_node(
                Node(
                    entity_id=person_eid(pid),
                    entity_type=NodeType.PERSON,
                    label=p["name"],
                    source_dataset="persons",
                    source_record_id=source_record_id("persons", pid),
                    attributes={
                        "city": p["city"],
                        "state": p["state"],
                        "location_id": p["location_id"],
                        # ring_id is the GROUND-TRUTH overlay label, not observed.
                        "ring_id": p["ring_id"],
                    },
                )
            )
            self.store.add_node(
                Node(
                    entity_id=phone_eid(p["phone"]),
                    entity_type=NodeType.PHONE,
                    label=p["phone"],
                    source_dataset="persons",
                    source_record_id=source_record_id("persons", pid),
                )
            )
            self.store.add_node(
                Node(
                    entity_id=aadhaar_eid(p["aadhar"]),
                    entity_type=NodeType.AADHAAR,
                    label=p["aadhar"],
                    source_dataset="persons",
                    source_record_id=source_record_id("persons", pid),
                )
            )

        for loc in sorted(self.repo.locations, key=lambda x: x["location_id"]):
            lid = loc["location_id"]
            self.store.add_node(
                Node(
                    entity_id=location_eid(lid),
                    entity_type=NodeType.LOCATION,
                    label=f"{loc['city']}, {loc['state']}",
                    source_dataset="locations",
                    source_record_id=source_record_id("locations", lid),
                    attributes={
                        "city": loc["city"],
                        "state": loc["state"],
                        "canonical_lat": loc["canonical_lat"],
                        "canonical_lng": loc["canonical_lng"],
                    },
                )
            )

        for f in sorted(self.repo.firs, key=lambda x: x["fir_id"]):
            fid = f["fir_id"]
            self.store.add_node(
                Node(
                    entity_id=fir_eid(fid),
                    entity_type=NodeType.FIR,
                    label=f"FIR {fid} ({f['date']})",
                    source_dataset="firs",
                    source_record_id=source_record_id("firs", fid),
                    attributes={"date": f["date"], "location_id": f["location_id"]},
                )
            )

        # Auxiliary CELL_TOWER nodes (endpoints of USED_TOWER).
        towers = sorted({c["cell_tower_id"] for c in self.repo.calls})
        for tid in towers:
            self.store.add_node(
                Node(
                    entity_id=tower_eid(tid),
                    entity_type=NodeType.CELL_TOWER,
                    label=f"Tower {tid}",
                    source_dataset="calls",
                    # Derived from the calls.cell_tower_id column (there is no
                    # towers table); keep the node's provenance label honest.
                    source_record_id=source_record_id("calls.cell_tower_id", tid),
                )
            )
        self.stats["distinct_towers"] = len(towers)

    # -- identity edges ----------------------------------------------------
    def _add_identity_edges(self) -> None:
        for p in sorted(self.repo.persons, key=lambda x: x["person_id"]):
            pid = p["person_id"]
            src = person_eid(pid)
            rec = source_record_id("persons", pid)
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(
                        EdgeType.OWNS_PHONE, src, phone_eid(p["phone"])
                    ),
                    source_entity_id=src,
                    target_entity_id=phone_eid(p["phone"]),
                    relationship_type=EdgeType.OWNS_PHONE,
                    directed=True,
                    source_dataset="persons",
                    evidence=[rec],
                )
            )
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(
                        EdgeType.OWNS_AADHAAR, src, aadhaar_eid(p["aadhar"])
                    ),
                    source_entity_id=src,
                    target_entity_id=aadhaar_eid(p["aadhar"]),
                    relationship_type=EdgeType.OWNS_AADHAAR,
                    directed=True,
                    source_dataset="persons",
                    evidence=[rec],
                )
            )

    def _add_located_at(self) -> None:
        for p in sorted(self.repo.persons, key=lambda x: x["person_id"]):
            src = person_eid(p["person_id"])
            tgt = location_eid(p["location_id"])
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(EdgeType.LOCATED_AT, src, tgt),
                    source_entity_id=src,
                    target_entity_id=tgt,
                    relationship_type=EdgeType.LOCATED_AT,
                    directed=True,
                    source_dataset="persons",
                    evidence=[source_record_id("persons", p["person_id"])],
                    attributes={"subject_type": "PERSON"},
                )
            )
        for f in sorted(self.repo.firs, key=lambda x: x["fir_id"]):
            src = fir_eid(f["fir_id"])
            tgt = location_eid(f["location_id"])
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(EdgeType.LOCATED_AT, src, tgt),
                    source_entity_id=src,
                    target_entity_id=tgt,
                    relationship_type=EdgeType.LOCATED_AT,
                    directed=True,
                    source_dataset="firs",
                    evidence=[source_record_id("firs", f["fir_id"])],
                    attributes={"subject_type": "FIR"},
                )
            )

    # -- communication / financial (aggregated, directed) ------------------
    def _add_called(self) -> None:
        agg: dict[tuple[int, int], dict] = defaultdict(
            lambda: {"count": 0, "total_duration_sec": 0, "evidence": [], "lo": None, "hi": None}
        )
        for c in sorted(self.repo.calls, key=lambda x: x["call_id"]):
            key = (c["caller_id"], c["callee_id"])
            a = agg[key]
            a["count"] += 1
            a["total_duration_sec"] += c["duration_sec"]
            a["evidence"].append(source_record_id("calls", c["call_id"]))
            a["lo"], a["hi"] = _minmax(a["lo"], a["hi"], c["start_time"])
        for (caller, callee), a in sorted(agg.items()):
            src, tgt = person_eid(caller), person_eid(callee)
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(EdgeType.CALLED, src, tgt),
                    source_entity_id=src,
                    target_entity_id=tgt,
                    relationship_type=EdgeType.CALLED,
                    directed=True,
                    source_dataset="calls",
                    evidence=a["evidence"],
                    weight=float(a["count"]),
                    weight_detail={"count": a["count"], "total_duration_sec": a["total_duration_sec"]},
                    date_first=a["lo"],
                    date_last=a["hi"],
                )
            )

    def _add_transacted(self) -> None:
        agg: dict[tuple[int, int], dict] = defaultdict(
            lambda: {"count": 0, "total_amount_inr": 0.0, "evidence": [], "lo": None, "hi": None}
        )
        for t in sorted(self.repo.transactions, key=lambda x: x["txn_id"]):
            key = (t["sender_id"], t["receiver_id"])
            a = agg[key]
            a["count"] += 1
            a["total_amount_inr"] += t["amount_inr"]
            a["evidence"].append(source_record_id("transactions", t["txn_id"]))
            a["lo"], a["hi"] = _minmax(a["lo"], a["hi"], t["txn_time"])
        for (sender, receiver), a in sorted(agg.items()):
            src, tgt = person_eid(sender), person_eid(receiver)
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(EdgeType.TRANSACTED, src, tgt),
                    source_entity_id=src,
                    target_entity_id=tgt,
                    relationship_type=EdgeType.TRANSACTED,
                    directed=True,
                    source_dataset="transactions",
                    evidence=a["evidence"],
                    weight=float(a["count"]),
                    weight_detail={
                        "count": a["count"],
                        "total_amount_inr": round(a["total_amount_inr"], 2),
                    },
                    date_first=a["lo"],
                    date_last=a["hi"],
                )
            )

    # -- FIR-derived edges -------------------------------------------------
    def _add_fir_edges(self) -> None:
        # NAMED_IN_FIR (structured roles only — never parsed from narrative).
        for f in sorted(self.repo.firs, key=lambda x: x["fir_id"]):
            fid = f["fir_id"]
            rec = source_record_id("firs", fid)
            fir_node = fir_eid(fid)
            for role, person_col in (("complainant", "complainant_id"), ("accused", "accused_id")):
                src = person_eid(f[person_col])
                self.store.add_edge(
                    Edge(
                        relationship_id=make_relationship_id(
                            EdgeType.NAMED_IN_FIR, src, fir_node, role=role
                        ),
                        source_entity_id=src,
                        target_entity_id=fir_node,
                        relationship_type=EdgeType.NAMED_IN_FIR,
                        directed=True,
                        source_dataset="firs",
                        evidence=[rec],
                        attributes={"role": role, "fir_date": f["date"]},
                        date_first=f["date"],
                        date_last=f["date"],
                    )
                )

        # REPORTED_AGAINST (complainant -> accused), aggregated per ordered pair.
        agg: dict[tuple[int, int], dict] = defaultdict(
            lambda: {"count": 0, "evidence": [], "lo": None, "hi": None}
        )
        for f in sorted(self.repo.firs, key=lambda x: x["fir_id"]):
            key = (f["complainant_id"], f["accused_id"])
            a = agg[key]
            a["count"] += 1
            a["evidence"].append(source_record_id("firs", f["fir_id"]))
            a["lo"], a["hi"] = _minmax(a["lo"], a["hi"], f["date"])
        for (complainant, accused), a in sorted(agg.items()):
            src, tgt = person_eid(complainant), person_eid(accused)
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(EdgeType.REPORTED_AGAINST, src, tgt),
                    source_entity_id=src,
                    target_entity_id=tgt,
                    relationship_type=EdgeType.REPORTED_AGAINST,
                    directed=True,
                    source_dataset="firs",
                    evidence=a["evidence"],
                    weight=float(a["count"]),
                    weight_detail={"fir_count": a["count"]},
                    date_first=a["lo"],
                    date_last=a["hi"],
                )
            )

    # -- derived: co-location with clique guard ----------------------------
    def _add_co_located(self) -> None:
        cap = self.settings.co_located_max_group
        by_location: dict[int, list[int]] = defaultdict(list)
        for p in self.repo.persons:
            by_location[p["location_id"]].append(p["person_id"])

        edges = skipped = 0
        max_group = 0
        for lid in sorted(by_location):
            members = sorted(by_location[lid])
            max_group = max(max_group, len(members))
            if len(members) > cap:
                skipped += 1
                continue  # guard against O(n^2) clique explosion at popular sites
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    a, b = person_eid(members[i]), person_eid(members[j])
                    self.store.add_edge(
                        Edge(
                            relationship_id=make_relationship_id(EdgeType.CO_LOCATED, a, b),
                            source_entity_id=a,
                            target_entity_id=b,
                            relationship_type=EdgeType.CO_LOCATED,
                            directed=False,
                            source_dataset="persons",
                            evidence=[
                                source_record_id("persons", members[i]),
                                source_record_id("persons", members[j]),
                            ],
                            weight=1.0,
                            attributes={"shared_location_id": lid},
                        )
                    )
                    edges += 1
        self.stats["co_located"] = {
            "edges": edges,
            "skipped_groups_over_cap": skipped,
            "max_group_size": max_group,
            "cap": cap,
        }

    # -- derived: tower usage ----------------------------------------------
    def _add_used_tower(self) -> None:
        agg: dict[tuple[int, int], dict] = defaultdict(
            lambda: {"count": 0, "evidence": [], "lo": None, "hi": None}
        )
        for c in sorted(self.repo.calls, key=lambda x: x["call_id"]):
            key = (c["caller_id"], c["cell_tower_id"])
            a = agg[key]
            a["count"] += 1
            a["evidence"].append(source_record_id("calls", c["call_id"]))
            a["lo"], a["hi"] = _minmax(a["lo"], a["hi"], c["start_time"])
        for (caller, tower), a in sorted(agg.items()):
            src, tgt = person_eid(caller), tower_eid(tower)
            self.store.add_edge(
                Edge(
                    relationship_id=make_relationship_id(EdgeType.USED_TOWER, src, tgt),
                    source_entity_id=src,
                    target_entity_id=tgt,
                    relationship_type=EdgeType.USED_TOWER,
                    directed=True,
                    source_dataset="calls",
                    evidence=a["evidence"],
                    weight=float(a["count"]),
                    weight_detail={"count": a["count"]},
                    date_first=a["lo"],
                    date_last=a["hi"],
                )
            )

    # -- ground-truth overlay (kept separate from observed intelligence) ---
    def _add_same_ring_overlay(self) -> None:
        by_ring: dict[int, list[int]] = defaultdict(list)
        for p in self.repo.persons:
            if p["ring_id"] is not None:
                by_ring[p["ring_id"]].append(p["person_id"])
        edges = 0
        ring_sizes: dict[int, int] = {}
        for ring in sorted(by_ring):
            members = sorted(by_ring[ring])
            ring_sizes[ring] = len(members)
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    a, b = person_eid(members[i]), person_eid(members[j])
                    self.store.add_edge(
                        Edge(
                            relationship_id=make_relationship_id(EdgeType.SAME_RING, a, b),
                            source_entity_id=a,
                            target_entity_id=b,
                            relationship_type=EdgeType.SAME_RING,
                            directed=False,
                            source_dataset="persons",
                            evidence=[
                                source_record_id("persons", members[i]),
                                source_record_id("persons", members[j]),
                            ],
                            weight=1.0,
                            is_overlay=True,
                            attributes={"ring_id": ring},
                        )
                    )
                    edges += 1
        self.stats["same_ring_overlay"] = {
            "edges": edges,
            "ring_sizes": dict(sorted(ring_sizes.items())),
            "persons_in_a_ring": sum(ring_sizes.values()),
        }


def build_store(repo: DatasetRepository, settings: Settings) -> tuple[GraphStore, dict]:
    """Build a graph store from the repository; returns (store, build_stats)."""
    builder = GraphBuilder(repo, settings)
    store = builder.build()
    return store, builder.stats
