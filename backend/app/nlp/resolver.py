"""Entity resolution: link an extracted mention to an existing graph entity.

Phase 3 spec §5. The resolver walks a fixed priority ladder and STOPS at the
first tier that yields a single answer:

1. **Exact structured identifier** — the normalized PHONE/AADHAAR equals a value
   in ``persons.csv``. These are unique in the dataset (0 duplicate phones,
   0 duplicate Aadhaar numbers), so a hit is unambiguous.
   → ``CONF_RES_IDENTIFIER``
2. **Normalized exact match** — the normalized PERSON name / ``"City, State"``
   equals exactly one structured record. → ``CONF_RES_UNIQUE_NAME``
3. **Safe deterministic match** — several records matched, and the FIR's OWN
   foreign keys (``complainant_id`` / ``accused_id`` / ``location_id``) single one
   out. This is structural corroboration, not textual evidence, so it sits one
   tier lower. → ``CONF_RES_FIR_CONTEXT``
4. **Ambiguous** — more than one candidate survives. ``matched_entity_id`` stays
   ``None``, ``ambiguous=True``, and every candidate id is listed. Ambiguous
   people are NEVER silently merged.
5. **Unresolved** — no candidate, or the best score is below
   ``settings.nlp_resolution_min_confidence``. The reason is always populated.

DATE / MONEY / VEHICLE / ORGANIZATION resolve to ``NOT_APPLICABLE``: the Phase 2
graph materialises no node of those kinds (``FUTURE_NODE_TYPES`` in
``app.graph.model``), so there is nothing to link to. The values are still
returned to the caller and DATE is carried as relationship metadata.

The resolver reads only the structured dataset, never the graph store, so it has
no way to invent an entity that does not already exist.
"""
from __future__ import annotations

from typing import Optional

from app.config import Settings
from app.graph.model import aadhaar_eid, location_eid, person_eid, phone_eid, source_record_id
from app.nlp import normalizer as norm
from app.nlp.models import (
    CONF_RES_FIR_CONTEXT,
    CONF_RES_IDENTIFIER,
    CONF_RES_UNIQUE_NAME,
    EntityResolution,
    EntityType,
    ExtractedEntity,
    ResolutionStatus,
    ResolvedEntity,
)

# Entity types with no materialised Phase 2 node to link to.
_NON_RESOLVABLE: frozenset[EntityType] = frozenset(
    {EntityType.DATE, EntityType.MONEY, EntityType.VEHICLE, EntityType.ORGANIZATION}
)
_NON_RESOLVABLE_REASONS: dict[EntityType, str] = {
    EntityType.DATE: (
        "no DATE/EVENT node type is materialised in the Phase 2 graph; the value is "
        "retained as relationship metadata"
    ),
    EntityType.MONEY: (
        "no monetary node type is materialised in the Phase 2 graph; TRANSACTED edges "
        "come from the structured transactions table"
    ),
    EntityType.VEHICLE: "VEHICLE is a future node type with no source records in this dataset",
    EntityType.ORGANIZATION: (
        "ORGANIZATION is a future node type with no source records in this dataset"
    ),
}


class EntityResolver:
    """Resolves extracted mentions against the loaded structured dataset."""

    def __init__(self, repo, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings

        # --- identifier indexes (normalized value -> person record) ---------
        self._by_phone: dict[str, list[dict]] = {}
        self._by_aadhaar: dict[str, list[dict]] = {}
        self._by_name: dict[str, list[dict]] = {}
        for p in repo.persons:
            self._by_phone.setdefault(norm.normalize_phone(p["phone"]), []).append(p)
            self._by_aadhaar.setdefault(norm.normalize_aadhaar(p["aadhar"]), []).append(p)
            self._by_name.setdefault(norm.normalize_name(p["name"]).casefold(), []).append(p)

        # --- location indexes ------------------------------------------------
        self._by_place: dict[str, list[dict]] = {}
        for loc in repo.locations:
            city = norm.normalize_whitespace(loc["city"])
            state = norm.normalize_whitespace(loc["state"])
            if city and state:
                self._by_place.setdefault(f"{city}, {state}".casefold(), []).append(loc)
            if city:
                self._by_place.setdefault(city.casefold(), []).append(loc)

    # -- lookups used by relationship extraction -----------------------------
    def person_by_phone(self, normalized_phone: str) -> Optional[dict]:
        matches = self._by_phone.get(normalized_phone, [])
        return matches[0] if len(matches) == 1 else None

    def person_by_aadhaar(self, normalized_aadhaar: str) -> Optional[dict]:
        matches = self._by_aadhaar.get(normalized_aadhaar, [])
        return matches[0] if len(matches) == 1 else None

    # -- resolution ----------------------------------------------------------
    def resolve(self, entity: ExtractedEntity) -> EntityResolution:
        """Resolve one extracted entity. Never raises; always explains itself."""
        if entity.entity_type in _NON_RESOLVABLE:
            return EntityResolution(
                status=ResolutionStatus.NOT_APPLICABLE,
                reason=_NON_RESOLVABLE_REASONS[entity.entity_type],
            )
        if entity.entity_type is EntityType.PHONE:
            return self._resolve_identifier(
                entity,
                index=self._by_phone,
                make_id=lambda rec: phone_eid(rec["phone"]),
                label="phone",
            )
        if entity.entity_type is EntityType.AADHAAR:
            return self._resolve_identifier(
                entity,
                index=self._by_aadhaar,
                make_id=lambda rec: aadhaar_eid(rec["aadhar"]),
                label="aadhaar",
            )
        if entity.entity_type is EntityType.PERSON:
            return self._resolve_person(entity)
        if entity.entity_type is EntityType.LOCATION:
            return self._resolve_location(entity)
        return EntityResolution(
            status=ResolutionStatus.UNRESOLVED,
            reason=f"no resolution strategy for entity type {entity.entity_type.value}",
        )

    def resolve_all(self, entities: list[ExtractedEntity]) -> list[ResolvedEntity]:
        return [ResolvedEntity(entity=e, resolution=self.resolve(e)) for e in entities]

    # -- tier 1: structured identifiers --------------------------------------
    def _resolve_identifier(self, entity, *, index, make_id, label) -> EntityResolution:
        matches = index.get(entity.normalized_value, [])
        if not matches:
            return EntityResolution(
                status=ResolutionStatus.UNRESOLVED,
                reason=f"{label} {entity.normalized_value!r} matches no person record",
            )
        if len(matches) > 1:
            return EntityResolution(
                status=ResolutionStatus.AMBIGUOUS,
                ambiguous=True,
                candidates=sorted(make_id(rec) for rec in matches),
                resolution_method="structured_identifier",
                reason=(
                    f"{len(matches)} person records share this {label}; not merged "
                    "without further evidence"
                ),
            )
        rec = matches[0]
        return self._accept(
            matched_entity_id=make_id(rec),
            method="structured_identifier",
            confidence=CONF_RES_IDENTIFIER,
            # The identifier node's owning person is the corroborating record.
            evidence=[source_record_id("persons", rec["person_id"])],
        )

    # -- tiers 2+3: persons ---------------------------------------------------
    def _resolve_person(self, entity: ExtractedEntity) -> EntityResolution:
        key = entity.normalized_value.casefold()
        matches = self._by_name.get(key, [])
        if not matches:
            return EntityResolution(
                status=ResolutionStatus.UNRESOLVED,
                reason=(
                    f"name {entity.normalized_value!r} matches no person record; "
                    "no fuzzy name matching is performed (it would risk merging "
                    "distinct people)"
                ),
            )
        if len(matches) == 1:
            rec = matches[0]
            return self._accept(
                matched_entity_id=person_eid(rec["person_id"]),
                method="normalized_name",
                confidence=CONF_RES_UNIQUE_NAME,
                evidence=[source_record_id("persons", rec["person_id"])],
            )

        # Tier 3: several people share this name — let the FIR's own foreign keys
        # decide, but only if exactly one candidate is named by this FIR.
        fir = self.repo.get_fir(entity.fir_id)
        candidates = sorted(person_eid(rec["person_id"]) for rec in matches)
        if fir is not None:
            role_field = {
                "complainant": "complainant_id",
                "accused": "accused_id",
            }.get(entity.role or "")
            expected_ids = (
                {fir[role_field]}
                if role_field
                else {fir["complainant_id"], fir["accused_id"]}
            )
            corroborated = [r for r in matches if r["person_id"] in expected_ids]
            if len(corroborated) == 1:
                rec = corroborated[0]
                return self._accept(
                    matched_entity_id=person_eid(rec["person_id"]),
                    method="fir_context_role" if role_field else "fir_context_party",
                    confidence=CONF_RES_FIR_CONTEXT,
                    evidence=[
                        source_record_id("persons", rec["person_id"]),
                        source_record_id("firs", entity.fir_id),
                    ],
                    candidates=candidates,
                    reason=(
                        f"{len(matches)} person records share the name "
                        f"{entity.normalized_value!r}; disambiguated by this FIR's "
                        f"own {role_field or 'complainant/accused'} reference"
                    ),
                )

        return EntityResolution(
            status=ResolutionStatus.AMBIGUOUS,
            ambiguous=True,
            candidates=candidates,
            resolution_method="normalized_name",
            reason=(
                f"{len(matches)} person records share the name "
                f"{entity.normalized_value!r} and this FIR does not single one out; "
                "left unresolved rather than merging distinct people"
            ),
        )

    # -- tiers 2+3: locations -------------------------------------------------
    def _resolve_location(self, entity: ExtractedEntity) -> EntityResolution:
        key = norm.normalize_location(entity.normalized_value).casefold()
        matches = self._by_place.get(key, [])
        if not matches:
            return EntityResolution(
                status=ResolutionStatus.UNRESOLVED,
                reason=f"place {entity.normalized_value!r} matches no location record",
            )
        candidates = sorted({location_eid(loc["location_id"]) for loc in matches})
        if len(matches) == 1:
            loc = matches[0]
            return self._accept(
                matched_entity_id=location_eid(loc["location_id"]),
                method="normalized_place",
                confidence=CONF_RES_UNIQUE_NAME,
                evidence=[source_record_id("locations", loc["location_id"])],
            )

        # Tier 3: many location rows share a city/state. The FIR's own
        # location_id resolves it, provided that record's city/state is what the
        # narrative actually names.
        fir = self.repo.get_fir(entity.fir_id)
        if fir is not None:
            fir_loc = self.repo.get_location(fir["location_id"])
            if fir_loc is not None and any(
                loc["location_id"] == fir_loc["location_id"] for loc in matches
            ):
                return self._accept(
                    matched_entity_id=location_eid(fir_loc["location_id"]),
                    method="fir_context_location",
                    confidence=CONF_RES_FIR_CONTEXT,
                    evidence=[
                        source_record_id("locations", fir_loc["location_id"]),
                        source_record_id("firs", entity.fir_id),
                    ],
                    candidates=candidates,
                    reason=(
                        f"{len(matches)} location records share "
                        f"{entity.normalized_value!r}; disambiguated by this FIR's own "
                        "location_id (the narrative names a city/state, not a precise "
                        "address)"
                    ),
                )

        return EntityResolution(
            status=ResolutionStatus.AMBIGUOUS,
            ambiguous=True,
            candidates=candidates,
            resolution_method="normalized_place",
            reason=(
                f"{len(matches)} location records share {entity.normalized_value!r} "
                "and this FIR does not single one out"
            ),
        )

    # -- shared acceptance gate ----------------------------------------------
    def _accept(
        self,
        *,
        matched_entity_id: str,
        method: str,
        confidence: float,
        evidence: list[str],
        candidates: Optional[list[str]] = None,
        reason: Optional[str] = None,
    ) -> EntityResolution:
        """Apply the configured minimum-confidence threshold (spec §5)."""
        threshold = self.settings.nlp_resolution_min_confidence
        if confidence < threshold:
            return EntityResolution(
                status=ResolutionStatus.UNRESOLVED,
                resolution_method=method,
                confidence=confidence,
                candidates=candidates or [],
                reason=(
                    f"best match scored {confidence} via {method}, below the "
                    f"configured minimum of {threshold}"
                ),
            )
        return EntityResolution(
            status=ResolutionStatus.RESOLVED,
            matched_entity_id=matched_entity_id,
            resolution_method=method,
            confidence=confidence,
            evidence=evidence,
            ambiguous=False,
            candidates=candidates or [],
            reason=reason,
        )
