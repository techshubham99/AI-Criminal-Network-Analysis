"""The ingestion gate (spec §4, §6, §7, §8).

Every submission walks the same nine steps, in this order, and cannot skip one:

1. schema validation (Pydantic, at the HTTP edge)
2. normalization
3. duplicate detection
4. entity resolution
5. relationship validation
6. provenance / evidence validation
7. decision — ACCEPTED / DUPLICATE / REVIEW_REQUIRED / REJECTED
8. persistence (of the record and its verdict, in the writable store only)
9. graph update and intelligence recomputation — **for accepted records only**

Caller input never reaches the graph directly. Steps 1–7 run before any write,
and step 9 writes *derived* rows built from the normalized payload and resolved
entity ids — never the raw submission. A record that needs a human stops at step
8 with its reason attached, and a new-but-unconnected record is neither forced
into the existing network nor treated as suspicious for being new.

Ingestion is serialized by a lock: submissions are cheap but recomputation is
global, and a deterministic order is what makes record ids, live row ids and
graph aggregates reproducible.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime
from typing import Any, Callable, Optional

from app.config import Settings
from app.core.errors import NotFoundError
from app.graph.model import fir_eid, location_eid, person_eid, tower_eid
from app.graph.store import GraphStore
from app.ingest import external
from app.ingest.bulk import BulkIngest
from app.ingest.events import EventBus, EventType
from app.ingest.graph_update import GraphUpdater
from app.ingest.models import (
    INGEST_DISCLAIMER,
    NO_LINK_EXPLANATION,
    EntityMatch,
    IngestRecord,
    IngestStatus,
    MatchStatus,
    Provenance,
    RejectReason,
    RelationshipDecision,
    ReviewReason,
    SourceType,
    make_record_id,
)
from app.ingest.normalize import FieldError, normalize
from app.ingest.recompute import Recomputer
from app.ingest.resolution import IngestResolver
from app.ingest.store import IngestStore
from app.nlp.models import ResolutionStatus

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


class IngestPipeline:
    """Judges submissions and applies the accepted ones."""

    def __init__(
        self,
        repo,
        settings: Settings,
        graph_service,
        nlp_service=None,
        intelligence=None,
        *,
        bus: Optional[EventBus] = None,
        publish_intelligence: Optional[Callable[[Any], None]] = None,
        audit=None,
    ) -> None:
        self.repo = repo
        self.settings = settings
        self.graph = graph_service
        self.nlp = nlp_service
        self.intelligence = intelligence
        self.bus = bus or EventBus(settings)
        self._publish_intelligence = publish_intelligence
        # Phase 5. Optional: an unavailable ledger leaves ingestion working and
        # says so on the response, rather than refusing submissions.
        self.audit = audit

        self.store = IngestStore(settings, repo)
        self.resolver = IngestResolver(repo, settings)
        self.recomputer = Recomputer(
            repo,
            settings,
            graph_service.store,
            self.store,
            narrative_store=getattr(getattr(nlp_service, "integrator", None), "store", None),
        )
        self._lock = threading.RLock()
        self.replayed = 0
        # Phase 6.2. Holds in-memory previews only; every judgement and every
        # write it makes goes through this pipeline, so there is no second engine.
        self.bulk = BulkIngest(self)

    # ==================================================================
    # submit
    # ==================================================================
    def submit(
        self,
        source_type: SourceType,
        payload: dict[str, Any],
        provenance: Provenance,
        *,
        emit_events: bool = True,
        ingested_at: Optional[str] = None,
    ) -> IngestRecord:
        with self._lock:
            record = self._submit(
                source_type, payload, provenance, emit_events=emit_events,
                ingested_at=ingested_at,
            )
            self._audit(record)
            return record

    def _audit(self, record: IngestRecord) -> None:
        """Append this submission's audit events (Phase 5 §11).

        Called with the ingestion lock still held, so the chain is written by a
        single writer in decision order. The event bus is deliberately not the
        source: it is asynchronous and drops frames for a slow subscriber, and a
        ledger that can lose events is not a ledger.

        A ledger failure does not undo an accepted record — the graph has already
        changed by this point — so it is reported on the response instead of being
        hidden or rolled back.
        """
        if self.audit is None:
            return
        try:
            events = self.audit.record_submission(record)
            record.impact["audit_event_ids"] = [e.audit_event_id for e in events]
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Audit append failed for record %s", record.record_id)
            record.impact["audit_error"] = f"{type(exc).__name__}: {exc}"

    def _submit(
        self,
        source_type: SourceType,
        payload: dict[str, Any],
        provenance: Provenance,
        *,
        emit_events: bool,
        ingested_at: Optional[str],
    ) -> IngestRecord:
        """Judge one submission (steps 2-7) and act on the verdict (steps 8, 9)."""
        record = self.classify(
            source_type, payload, provenance, ingested_at=ingested_at
        )

        if record.status is IngestStatus.REJECTED:
            return record

        if record.status is IngestStatus.DUPLICATE:
            resubmissions = self.store.note_duplicate(record.record_id)
            record.impact["resubmissions"] = resubmissions
            logger.info(
                "Duplicate %s submission for record %s (resubmission %d)",
                source_type.value, record.record_id[:12], resubmissions,
            )
            return record

        if record.status is not IngestStatus.ACCEPTED:
            self.store.put(record)
            return record

        # --- steps 5, 8, 9: apply -------------------------------------------
        return self._apply(record, emit_events=emit_events)

    def classify(
        self,
        source_type: SourceType,
        payload: dict[str, Any],
        provenance: Provenance,
        *,
        ingested_at: Optional[str] = None,
    ) -> IngestRecord:
        """Steps 2-7: reach a verdict without writing anything.

        Normalization, duplicate detection, entity resolution, provenance
        validation and the decision itself are all read-only, so the same
        judgement serves a real submission and a Phase 6.2 preview. Nothing is
        stored, no resubmission is counted and no graph is touched here — the
        caller decides what to do with the verdict.
        """
        raw = dict(payload)
        at = ingested_at or _now()

        # --- step 2: normalization ------------------------------------------
        try:
            normalized = normalize(source_type.value, raw, self.settings)
        except FieldError as exc:
            return self._rejected(
                source_type, raw, provenance, at,
                RejectReason.INVALID_FIELD, exc.message, field=exc.field,
            )

        # --- step 3: duplicate detection ------------------------------------
        record_id = make_record_id(source_type, normalized)
        existing = self.store.get(record_id)
        if existing is not None:
            return IngestRecord(
                record_id=record_id,
                source_type=source_type,
                raw_payload=raw,
                normalized_payload=normalized,
                provenance=provenance,
                ingested_at=at,
                status=IngestStatus.DUPLICATE,
                validation_status="VALID",
                resolution_status=existing.resolution_status,
                reason=(
                    f"Identical record already {existing.status.value.lower()} "
                    f"on {existing.ingested_at}. No graph or intelligence change."
                ),
                matches=list(existing.matches),
                relationships=[],
                evidence=list(existing.evidence),
                entity_ids=list(existing.entity_ids),
                duplicate_of=record_id,
                impact={
                    "changed": False,
                    "note": (
                        "Duplicate submission: the observation was already "
                        "recorded, so nothing was added to the graph and no "
                        "intelligence was recomputed."
                    ),
                    "original_status": existing.status.value,
                },
            )

        # --- step 4: entity resolution --------------------------------------
        matches = self._resolve(source_type, normalized)

        # --- step 6: provenance validation ----------------------------------
        if not provenance.source_name.strip():
            return self._rejected(
                source_type, raw, provenance, at,
                RejectReason.SCHEMA_INVALID,
                "provenance.source_name is required: a record with no stated "
                "source cannot be evidence.",
                field="provenance.source_name",
            )

        # --- step 7: decision ------------------------------------------------
        status, review_reason, reason = self._decide(matches)
        record = IngestRecord(
            record_id=record_id,
            source_type=source_type,
            raw_payload=raw,
            normalized_payload=normalized,
            provenance=provenance,
            ingested_at=at,
            status=status,
            validation_status="VALID",
            resolution_status=(
                "RESOLVED" if status is IngestStatus.ACCEPTED else "UNRESOLVED"
            ),
            review_reason=review_reason,
            reason=reason,
            matches=matches,
            entity_ids=sorted(
                {m.entity_id for m in matches if m.entity_id is not None}
            ),
        )

        if status is not IngestStatus.ACCEPTED:
            record.impact = {
                "changed": False,
                "note": (
                    "Held for review: nothing was added to the graph and no "
                    "intelligence was recomputed."
                ),
            }
        return record

    # ==================================================================
    # resolution per source type
    # ==================================================================
    def _resolve(self, source_type: SourceType, normalized: dict) -> list[EntityMatch]:
        if source_type is SourceType.CALL:
            return [
                self.resolver.resolve_person(normalized["caller"], "caller"),
                self.resolver.resolve_person(normalized["callee"], "callee"),
            ]
        if source_type is SourceType.TRANSACTION:
            return [
                self.resolver.resolve_person(normalized["sender"], "sender"),
                self.resolver.resolve_person(normalized["receiver"], "receiver"),
            ]
        if source_type is SourceType.LOCATION:
            person = self.resolver.resolve_person(
                normalized["person"], "person", place=normalized["place"]
            )
            return [
                person,
                self.resolver.resolve_place(
                    normalized["place"],
                    "place",
                    anchor_person=self._record_for(person),
                ),
            ]
        # FIR
        place = normalized["place"]
        complainant = self.resolver.resolve_person(
            normalized["complainant"], "complainant", place=place
        )
        matches = [complainant]
        if "accused" in normalized:
            matches.append(
                self.resolver.resolve_person(normalized["accused"], "accused", place=place)
            )
        matches.append(
            self.resolver.resolve_place(
                place, "place", anchor_person=self._record_for(complainant)
            )
        )
        return matches

    def _record_for(self, match: EntityMatch) -> Optional[dict]:
        if not match.matched or match.entity_id is None:
            return None
        return self.resolver.person_record(match.entity_id)

    # ==================================================================
    # decision
    # ==================================================================
    def _decide(
        self, matches: list[EntityMatch]
    ) -> tuple[IngestStatus, Optional[ReviewReason], str]:
        """Turn the resolution outcomes into one status and one short reason.

        Ambiguity outranks absence on purpose: guessing which of several people
        a reference means is the more damaging error, so it is reported as its
        own reason and never resolved automatically.
        """
        ambiguous = [m for m in matches if m.status is MatchStatus.AMBIGUOUS]
        unmatched = [m for m in matches if m.status is MatchStatus.NO_MATCH]

        if ambiguous:
            fields = ", ".join(m.field_name for m in ambiguous)
            return (
                IngestStatus.REVIEW_REQUIRED,
                ReviewReason.AMBIGUOUS_MATCH,
                f"Cannot tell which existing record {fields} refers to. "
                + ambiguous[0].explanation,
            )
        if unmatched:
            if len(unmatched) == len(matches):
                # Nothing in this record connects to anything already recorded.
                # It is held, not linked, and not treated as suspicious.
                return (
                    IngestStatus.REVIEW_REQUIRED,
                    ReviewReason.NO_MATCH_NEW_ENTITY,
                    NO_LINK_EXPLANATION,
                )
            fields = ", ".join(m.field_name for m in unmatched)
            return (
                IngestStatus.REVIEW_REQUIRED,
                ReviewReason.NO_MATCH_NEW_ENTITY,
                f"New to this investigation: {fields}. " + unmatched[0].explanation,
            )
        return (
            IngestStatus.ACCEPTED,
            None,
            f"{len(matches)} reference(s) matched existing records.",
        )

    def _rejected(
        self,
        source_type: SourceType,
        raw: dict,
        provenance: Provenance,
        at: str,
        reason_code: RejectReason,
        message: str,
        *,
        field: Optional[str] = None,
    ) -> IngestRecord:
        """A rejected submission: reported, never stored as an observation.

        Its id is derived from the raw payload rather than a normalized one,
        because normalization is exactly what failed.
        """
        record = IngestRecord(
            record_id=make_record_id(source_type, {"__rejected__": raw}),
            source_type=source_type,
            raw_payload=raw,
            normalized_payload={},
            provenance=provenance,
            ingested_at=at,
            status=IngestStatus.REJECTED,
            validation_status="INVALID",
            resolution_status="NOT_ATTEMPTED",
            reject_reason=reason_code,
            reason=message if field is None else f"{field}: {message}",
            impact={"changed": False, "note": "Rejected: nothing was stored or changed."},
        )
        return record

    # ==================================================================
    # apply an accepted record (steps 5, 8, 9)
    # ==================================================================
    def write_record(
        self,
        record: IngestRecord,
        *,
        graph_store: GraphStore,
        ingest_store: IngestStore,
        run_nlp: bool = True,
    ) -> tuple[GraphUpdater, set[int], Optional[dict[str, Any]]]:
        """Steps 5 and 8 for one accepted record, against the given targets.

        Derived rows go to ``ingest_store`` and derived edges to ``graph_store``,
        so one code path serves a real submission (the live store and graph) and a
        Phase 6.2 preview (a snapshot store and an overlay graph). Nothing global
        is recomputed and nothing is published from here.

        ``run_nlp`` is off for a preview: the Phase 3 narrative pipeline writes
        into the live narrative overlay, which a preview must not touch.
        """
        by_field = {m.field_name: m for m in record.matches}
        updater = GraphUpdater(graph_store)
        decisions: list[RelationshipDecision] = []
        entity_ids: set[str] = set(record.entity_ids)
        person_ids: set[int] = set()
        norm = record.normalized_payload
        nlp_report: Optional[dict[str, Any]] = None

        def pid_of(field_name: str) -> int:
            return int(by_field[field_name].entity_id.split(":", 1)[1])

        def lid_of(field_name: str) -> int:
            return int(by_field[field_name].entity_id.split(":", 1)[1])

        if record.source_type is SourceType.CALL:
            caller, callee = pid_of("caller"), pid_of("callee")
            row = ingest_store.add_live_call(
                caller_id=caller,
                callee_id=callee,
                start_time=norm["start_time"],
                duration_sec=norm["duration_sec"],
                cell_tower_id=norm.get("cell_tower_id"),
            )
            rid, is_new = updater.called(row, record.record_id)
            self_ref = caller == callee
            decisions.append(
                RelationshipDecision(
                    relationship_type="CALLED",
                    source_entity_id=person_eid(caller),
                    target_entity_id=person_eid(callee),
                    accepted=True,
                    reason=(
                        "Self-reference: kept as evidence, excluded from "
                        "intelligence and centrality."
                        if self_ref
                        else "Both parties resolved to existing persons."
                    ),
                    relationship_id=rid,
                    is_new_edge=is_new,
                    is_self_reference=self_ref,
                    excluded_from_intelligence=self_ref,
                )
            )
            tower = updater.used_tower(row, record.record_id)
            if tower is not None:
                decisions.append(
                    RelationshipDecision(
                        relationship_type="USED_TOWER",
                        source_entity_id=person_eid(caller),
                        target_entity_id=tower_eid(int(norm["cell_tower_id"])),
                        accepted=True,
                        reason="Tower recorded on the call.",
                        relationship_id=tower[0],
                        is_new_edge=tower[1],
                    )
                )
            person_ids.update({caller, callee})
            record.evidence.append(f"calls:{row['call_id']}")

        elif record.source_type is SourceType.TRANSACTION:
            sender, receiver = pid_of("sender"), pid_of("receiver")
            row = ingest_store.add_live_transaction(
                sender_id=sender,
                receiver_id=receiver,
                amount_inr=norm["amount_inr"],
                txn_time=norm["txn_time"],
                mode=norm["mode"],
                bank_ref=norm["bank_ref"],
            )
            rid, is_new = updater.transacted(row, record.record_id)
            self_ref = sender == receiver
            decisions.append(
                RelationshipDecision(
                    relationship_type="TRANSACTED",
                    source_entity_id=person_eid(sender),
                    target_entity_id=person_eid(receiver),
                    accepted=True,
                    reason=(
                        "Self-transfer: kept as evidence, excluded from "
                        "intelligence and centrality."
                        if self_ref
                        else "Both parties resolved to existing persons."
                    ),
                    relationship_id=rid,
                    is_new_edge=is_new,
                    is_self_reference=self_ref,
                    excluded_from_intelligence=self_ref,
                )
            )
            person_ids.update({sender, receiver})
            record.evidence.append(f"transactions:{row['txn_id']}")

        elif record.source_type is SourceType.LOCATION:
            person, location = pid_of("person"), lid_of("place")
            row = ingest_store.add_live_observation(
                person_id=person,
                location_id=location,
                observed_at=norm.get("observed_at"),
            )
            rid, is_new = updater.observed_at(
                person, location, row["observed_at"], record.record_id
            )
            decisions.append(
                RelationshipDecision(
                    relationship_type="LOCATED_AT",
                    source_entity_id=person_eid(person),
                    target_entity_id=location_eid(location),
                    accepted=True,
                    reason=(
                        "Reported presence at an existing location. Recorded as "
                        "an observation; the person's address on file is not "
                        "overwritten."
                    ),
                    relationship_id=rid,
                    is_new_edge=is_new,
                )
            )
            person_ids.add(person)
            entity_ids.add(location_eid(location))
            record.evidence.append(f"ingest:{record.record_id}")

        else:  # FIR
            complainant = pid_of("complainant")
            accused = pid_of("accused") if "accused" in by_field else None
            row = ingest_store.add_live_fir(
                date=norm["date"],
                complainant_id=complainant,
                accused_id=accused,
                location_id=lid_of("place"),
                narrative=norm["narrative"],
            )
            updater.add_fir_node(row, record.record_id)
            fir_entity = fir_eid(int(row["fir_id"]))
            entity_ids.add(fir_entity)
            entity_ids.add(location_eid(int(row["location_id"])))

            rid, is_new = updater.named_in_fir(complainant, row, "complainant", record.record_id)
            decisions.append(
                RelationshipDecision(
                    relationship_type="NAMED_IN_FIR",
                    source_entity_id=person_eid(complainant),
                    target_entity_id=fir_entity,
                    accepted=True,
                    reason="Complainant named on the FIR.",
                    relationship_id=rid,
                    is_new_edge=is_new,
                )
            )
            if accused is not None:
                rid, is_new = updater.named_in_fir(accused, row, "accused", record.record_id)
                decisions.append(
                    RelationshipDecision(
                        relationship_type="NAMED_IN_FIR",
                        source_entity_id=person_eid(accused),
                        target_entity_id=fir_entity,
                        accepted=True,
                        reason="Accused named on the FIR.",
                        relationship_id=rid,
                        is_new_edge=is_new,
                    )
                )
                rid, is_new = updater.reported_against(complainant, accused, row, record.record_id)
                self_ref = complainant == accused
                decisions.append(
                    RelationshipDecision(
                        relationship_type="REPORTED_AGAINST",
                        source_entity_id=person_eid(complainant),
                        target_entity_id=person_eid(accused),
                        accepted=True,
                        reason=(
                            "Self-reference: kept as evidence, excluded from "
                            "intelligence and centrality."
                            if self_ref
                            else "Structured complainant/accused roles on the FIR."
                        ),
                        relationship_id=rid,
                        is_new_edge=is_new,
                        is_self_reference=self_ref,
                        excluded_from_intelligence=self_ref,
                    )
                )
                person_ids.add(accused)
            else:
                decisions.append(
                    RelationshipDecision(
                        relationship_type="REPORTED_AGAINST",
                        source_entity_id=person_eid(complainant),
                        target_entity_id=None,
                        accepted=False,
                        reason=(
                            "No accused named on this FIR; no counterparty is "
                            "inferred, so no complainant-to-accused relationship "
                            "is created."
                        ),
                    )
                )
            rid, is_new = updater.fir_located_at(row, record.record_id)
            decisions.append(
                RelationshipDecision(
                    relationship_type="LOCATED_AT",
                    source_entity_id=fir_entity,
                    target_entity_id=location_eid(int(row["location_id"])),
                    accepted=True,
                    reason="FIR recorded at an existing location.",
                    relationship_id=rid,
                    is_new_edge=is_new,
                )
            )
            person_ids.add(complainant)
            record.evidence.append(f"firs:{row['fir_id']}")

            # §7: the accepted FIR goes through the existing Phase 3 pipeline.
            # Narrative-derived relationships land in the narrative overlay, not
            # in the structured graph — the Phase 3 separation is preserved.
            if run_nlp and self.nlp is not None:
                nlp_report = self._run_nlp(row)

        record.relationships = decisions
        record.entity_ids = sorted(entity_ids | {person_eid(p) for p in person_ids})
        ingest_store.put(record)
        return updater, person_ids, nlp_report

    def _apply(self, record: IngestRecord, *, emit_events: bool) -> IngestRecord:
        """Write one accepted record, then recompute global state (step 9)."""
        updater, person_ids, nlp_report = self.write_record(
            record, graph_store=self.graph.store, ingest_store=self.store
        )
        decisions = record.relationships

        # --- step 9b: global recomputation ---------------------------------
        # The graph is already mutated at this point, so a recomputation failure
        # must not discard the record — it is reported instead of hidden.
        result: Optional[Any] = None
        recompute_error: Optional[str] = None
        try:
            result = self.recomputer.run(
                person_ids=sorted(person_ids),
                before_analytics=self.graph.cached_analytics,
                before_intelligence=self.intelligence,
            )
        except Exception as exc:  # pragma: no cover - defensive
            recompute_error = f"{type(exc).__name__}: {exc}"
            logger.exception("Recomputation failed after accepting %s", record.record_id)

        if result is not None:
            self.graph.publish_analytics(result.analytics)
            self.intelligence = result.intelligence
            if self._publish_intelligence is not None:
                self._publish_intelligence(result.intelligence)

        record.impact = {
            "changed": updater.change.touched_graph,
            "graph": updater.change.as_dict(),
            "graph_totals": {
                "nodes": self.graph.store.node_count(),
                "edges": self.graph.store.edge_count(),
            },
            "live_rows": self.store.live_counts(),
            "relationships_accepted": sum(1 for d in decisions if d.accepted),
            "relationships_rejected": sum(1 for d in decisions if not d.accepted),
        }
        if result is not None:
            record.impact.update(result.as_dict())
            record.reason = self._accepted_reason(record, result)
        else:
            record.impact["recompute_error"] = recompute_error
            record.reason = (
                f"{sum(1 for d in decisions if d.accepted)} relationship(s) accepted; "
                "intelligence recomputation failed and served scores may be stale."
            )
        if nlp_report is not None:
            record.impact["nlp"] = nlp_report

        if emit_events and result is not None:
            self._emit(record, result, updater)
        return record

    def apply_batch(
        self, records: list[IngestRecord], *, emit_events: bool = True
    ) -> dict[str, Any]:
        """Apply several accepted records, recomputing global state exactly once.

        The recomputation in :meth:`_apply` is global — PageRank, betweenness and
        communities are properties of the whole graph — so running it per record
        would pay for the same work N times and report N sets of "new patterns"
        for one import. A batch writes every record, then recomputes once, and the
        result describes the import rather than any single row in it.
        """
        with self._lock:
            if not records:
                # Nothing was written, so nothing global can have changed. A
                # recomputation here would cost a full analytics pass to prove it.
                return {
                    "record_ids": [],
                    "person_ids": [],
                    "graph_totals": {
                        "nodes": self.graph.store.node_count(),
                        "edges": self.graph.store.edge_count(),
                    },
                    "live_rows": self.store.live_counts(),
                    "new_pattern_ids": [],
                    "cleared_pattern_ids": [],
                    "priority_changes": [],
                    "recompute_cost_ms": {},
                }

            person_ids: set[int] = set()
            for record in records:
                updater, touched, nlp_report = self.write_record(
                    record, graph_store=self.graph.store, ingest_store=self.store
                )
                person_ids |= touched
                accepted = sum(1 for d in record.relationships if d.accepted)
                record.impact = {
                    "changed": updater.change.touched_graph,
                    "graph": updater.change.as_dict(),
                    "relationships_accepted": accepted,
                    "relationships_rejected": len(record.relationships) - accepted,
                    "note": (
                        "Committed as part of a bulk import; the global "
                        "recomputation ran once for the whole import."
                    ),
                }
                if nlp_report is not None:
                    record.impact["nlp"] = nlp_report
                record.reason = f"{accepted} relationship(s) accepted."

            result: Optional[Any] = None
            recompute_error: Optional[str] = None
            try:
                result = self.recomputer.run(
                    person_ids=sorted(person_ids),
                    before_analytics=self.graph.cached_analytics,
                    before_intelligence=self.intelligence,
                )
            except Exception as exc:  # pragma: no cover - defensive
                recompute_error = f"{type(exc).__name__}: {exc}"
                logger.exception(
                    "Recomputation failed after committing %d record(s)", len(records)
                )

            if result is not None:
                self.graph.publish_analytics(result.analytics)
                self.intelligence = result.intelligence
                if self._publish_intelligence is not None:
                    self._publish_intelligence(result.intelligence)

            out: dict[str, Any] = {
                "record_ids": [r.record_id for r in records],
                "person_ids": sorted(person_ids),
                "graph_totals": {
                    "nodes": self.graph.store.node_count(),
                    "edges": self.graph.store.edge_count(),
                },
                "live_rows": self.store.live_counts(),
            }
            for record in records:
                record.impact["graph_totals"] = out["graph_totals"]
                record.impact["live_rows"] = out["live_rows"]

            if result is None:
                out["recompute_error"] = recompute_error
                return out

            out.update(
                {
                    "new_pattern_ids": list(result.new_pattern_ids),
                    "cleared_pattern_ids": list(result.cleared_pattern_ids),
                    "priority_changes": list(result.priority_changes),
                    "recompute_cost_ms": result.cost_ms,
                }
            )
            if emit_events and records:
                self._emit_batch(records, result)
            return out

    def _run_nlp(self, fir_row: dict) -> dict[str, Any]:
        """Analyse an accepted FIR with the existing Phase 3 pipeline (§7).

        Nothing is re-derived here: extraction, resolution, relation extraction
        and the accept/reject accounting are Phase 3's, and this only reports
        them for the record. Narrative relationships land in the Phase 3
        narrative overlay, never in the structured graph, so the two kinds of
        evidence stay distinguishable.
        """
        analysis = self.nlp.ingest_fir(fir_row)

        def endpoints(addition) -> dict[str, Any]:
            rel = addition.relationship
            return {
                "type": rel.relationship_type.value,
                "source_entity_id": rel.source_entity_id,
                "target_entity_id": rel.target_entity_id,
                "confidence": rel.confidence,
                "status": addition.status.value,
                "reason": addition.reason,
                "relationship_id": addition.relationship_id,
                "is_narrative": True,
            }

        return {
            "fir_id": analysis.fir_id,
            "extracted_entities": [
                {
                    "type": r.entity.entity_type.value,
                    "value": r.entity.normalized_value,
                    "confidence": r.entity.confidence,
                    "extraction_method": r.entity.extraction_method.value,
                    "resolution_status": r.resolution.status.value,
                    "entity_id": r.resolution.matched_entity_id,
                    "method": r.resolution.resolution_method,
                }
                for r in analysis.resolved_entities
            ],
            "resolved_entity_ids": sorted(
                {
                    r.resolution.matched_entity_id
                    for r in analysis.resolved_entities
                    if r.resolution.matched_entity_id
                }
            ),
            # "New" in the narrative sense: mentioned in the text but matching no
            # existing record. Reported, never created as an entity.
            "new_entities": [
                {
                    "type": r.entity.entity_type.value,
                    "value": r.entity.normalized_value,
                    "reason": r.resolution.reason,
                }
                for r in analysis.resolved_entities
                if r.resolution.status is ResolutionStatus.UNRESOLVED
            ],
            "review_required_entities": [
                {
                    "type": r.entity.entity_type.value,
                    "value": r.entity.normalized_value,
                    "candidates": list(r.resolution.candidates),
                    "reason": r.resolution.reason,
                }
                for r in analysis.resolved_entities
                if r.resolution.status is ResolutionStatus.AMBIGUOUS
            ],
            "relationships_accepted": [
                endpoints(a) for a in analysis.graph_additions if a.accepted
            ],
            "relationships_rejected": [
                endpoints(a) for a in analysis.graph_additions if not a.accepted
            ],
            "entities": self.nlp.entity_report(analysis),
            "relationship_types": self.nlp.relationship_report(analysis),
            "impact": self.nlp.graph_impact(analysis),
            "note": (
                "Narrative-derived relationships are materialised in the Phase 3 "
                "narrative overlay and kept separate from structured observations."
            ),
        }

    @staticmethod
    def _accepted_reason(record: IngestRecord, result) -> str:
        parts = [f"{sum(1 for d in record.relationships if d.accepted)} relationship(s) accepted"]
        change = record.impact.get("graph", {})
        if change.get("edges_added"):
            parts.append(f"{len(change['edges_added'])} new edge(s)")
        if change.get("edges_updated"):
            parts.append(f"{len(change['edges_updated'])} edge(s) updated")
        if result.new_pattern_ids:
            parts.append(f"{len(result.new_pattern_ids)} new pattern(s)")
        if result.priority_changes:
            parts.append(f"{len(result.priority_changes)} priority change(s)")
        return "; ".join(parts) + "."

    # ==================================================================
    # events (spec §12)
    # ==================================================================
    def _emit(self, record: IngestRecord, result, updater: GraphUpdater) -> None:
        base = {"record_id": record.record_id, "source_type": record.source_type.value}
        rel_ids = [d.relationship_id for d in record.relationships if d.relationship_id]
        if rel_ids:
            self.bus.publish(
                EventType.RELATIONSHIP_ADDED,
                {
                    **base,
                    "relationship_ids": rel_ids,
                    "new_edges": len(updater.change.edges_added),
                    "updated_edges": len(updater.change.edges_updated),
                },
            )
        if record.entity_ids:
            self.bus.publish(
                EventType.ENTITY_UPDATED, {**base, "entity_ids": record.entity_ids}
            )
        if result.new_pattern_ids:
            self.bus.publish(
                EventType.PATTERN_DETECTED,
                {**base, "pattern_ids": result.new_pattern_ids,
                 "count": len(result.new_pattern_ids)},
            )
        if result.priority_changes:
            self.bus.publish(
                EventType.PRIORITY_CHANGED, {**base, "changes": result.priority_changes}
            )
        # Published last: the frontend's cue that the recomputation is finished
        # and served data is now consistent again.
        self.bus.publish(
            EventType.NEW_INTELLIGENCE,
            {
                **base,
                "status": record.status.value,
                "entity_ids": record.entity_ids,
                "new_patterns": len(result.new_pattern_ids),
                "priority_changes": len(result.priority_changes),
                "recompute_cost_ms": result.cost_ms.get("total_ms"),
            },
        )

    def _emit_batch(self, records: list[IngestRecord], result) -> None:
        """One set of frames for a whole import, not one set per row.

        The recomputation that produced ``result`` ran once for the import, so
        attributing its new patterns and band changes to any individual row would
        be a claim the computation does not support.
        """
        base = {
            "source_type": records[0].source_type.value,
            "records": len(records),
        }
        rel_ids = [
            d.relationship_id
            for r in records
            for d in r.relationships
            if d.relationship_id
        ]
        entity_ids = sorted({e for r in records for e in r.entity_ids})
        if rel_ids:
            self.bus.publish(
                EventType.RELATIONSHIP_ADDED, {**base, "relationship_ids": rel_ids}
            )
        if entity_ids:
            self.bus.publish(
                EventType.ENTITY_UPDATED, {**base, "entity_ids": entity_ids}
            )
        if result.new_pattern_ids:
            self.bus.publish(
                EventType.PATTERN_DETECTED,
                {**base, "pattern_ids": result.new_pattern_ids,
                 "count": len(result.new_pattern_ids)},
            )
        if result.priority_changes:
            self.bus.publish(
                EventType.PRIORITY_CHANGED, {**base, "changes": result.priority_changes}
            )
        self.bus.publish(
            EventType.NEW_INTELLIGENCE,
            {
                **base,
                "status": IngestStatus.ACCEPTED.value,
                "entity_ids": entity_ids,
                "new_patterns": len(result.new_pattern_ids),
                "priority_changes": len(result.priority_changes),
                "recompute_cost_ms": result.cost_ms.get("total_ms"),
            },
        )

    # ==================================================================
    # reads
    # ==================================================================
    def get(self, record_id: str) -> IngestRecord:
        record = self.store.get(record_id)
        if record is None:
            raise NotFoundError("Ingest record", record_id)
        return record

    def impact(self, record_id: str) -> dict[str, Any]:
        record = self.get(record_id)
        return {
            "record_id": record.record_id,
            "source_type": record.source_type.value,
            "status": record.status.value,
            "reason": record.reason,
            "impact": record.impact,
            "relationships": [r.as_dict() for r in record.relationships],
            "evidence": list(record.evidence),
            "entity_ids": list(record.entity_ids),
            "disclaimer": INGEST_DISCLAIMER,
        }

    def changes(self, entity_id: str) -> dict[str, Any]:
        """Live records that touched one entity (spec §3)."""
        records = self.store.for_entity(entity_id)
        return {
            "entity_id": entity_id,
            "count": len(records),
            "changes": [
                {
                    "record_id": r.record_id,
                    "source_type": r.source_type.value,
                    "status": r.status.value,
                    "at": r.ingested_at,
                    "reason": r.reason,
                    "relationship_ids": [
                        d.relationship_id for d in r.relationships if d.relationship_id
                    ],
                    "priority_change": next(
                        (
                            c
                            for c in r.impact.get("priority_changes", [])
                            if c.get("entity_id") == entity_id
                        ),
                        None,
                    ),
                }
                for r in records
            ],
            "disclaimer": INGEST_DISCLAIMER,
        }

    def summary(self) -> dict[str, Any]:
        return {
            "phase": "4.6 - Live Intelligence & New Data Ingestion",
            "records": self.store.counts(),
            "live_rows": self.store.live_counts(),
            "graph_totals": {
                "nodes": self.graph.store.node_count(),
                "edges": self.graph.store.edge_count(),
            },
            "events": self.bus.stats(),
            "persistence": {
                "enabled": self.settings.ingest_persist,
                "directory": str(self.settings.ingest_dir),
                "replayed_on_startup": self.replayed,
                "dataset_directory_written": False,
            },
            "external_sources": external.status(self.settings),
            "disclaimer": INGEST_DISCLAIMER,
        }

    # ==================================================================
    # replay
    # ==================================================================
    def replay(self) -> int:
        """Re-judge journalled submissions on startup, in original order.

        Replay goes through the *same* gate rather than restoring conclusions
        from disk, so a restored store can never disagree with the pipeline
        about what a record means. Record ids exclude the ingestion timestamp,
        so replay is idempotent by construction.
        """
        submissions = self.store.read_journal()
        if not submissions:
            return 0
        journal = self.store.suspend_journal()
        # Phase 5: a persisted ledger already holds these submissions' audit
        # events, so replaying through the audit hook would duplicate every one
        # of them. A ledger that did not persist has nothing, so replay re-audits
        # and the chain ends up describing the store that actually exists.
        audit = self.audit
        if audit is not None and audit.ledger.persisted:
            self.audit = None
        applied = 0
        try:
            for submission in submissions:
                record = self.submit(
                    submission.source_type,
                    submission.raw_payload,
                    submission.provenance,
                    emit_events=False,
                    ingested_at=submission.ingested_at,
                )
                if record.status in (IngestStatus.ACCEPTED, IngestStatus.REVIEW_REQUIRED):
                    applied += 1
        finally:
            self.store.resume_journal(journal)
            self.audit = audit
        self.replayed = applied
        logger.info("Replayed %d persisted ingest submission(s)", applied)
        return applied


def build_ingest_pipeline(
    repo,
    settings: Settings,
    graph_service,
    nlp_service=None,
    intelligence=None,
    *,
    publish_intelligence: Optional[Callable[[Any], None]] = None,
    audit=None,
) -> IngestPipeline:
    """Construct the pipeline and replay anything already persisted."""
    pipeline = IngestPipeline(
        repo,
        settings,
        graph_service,
        nlp_service,
        intelligence,
        publish_intelligence=publish_intelligence,
        audit=audit,
    )
    if settings.ingest_persist:
        pipeline.replay()
    return pipeline
