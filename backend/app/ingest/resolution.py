"""Entity resolution for submitted records (spec §5).

The ladder is the Phase 3 ladder, applied to structured payload fields instead
of narrative mentions, and it stops at the first rung that yields exactly one
answer:

1. **Exact trusted identifier** — ``person_id`` / ``phone`` / ``aadhaar``. These
   are unique in the corpus (0 duplicate phones, 0 duplicate Aadhaar numbers),
   so a hit is unambiguous.
2. **Normalized exact match** — the normalized name matches exactly one record.
3. **Safe deterministic match** — several records matched and another field on
   the SAME record singles one out (a shared name narrowed by the place named on
   the record; a city/state narrowed by the referenced person's own location
   row). Structural corroboration, never a similarity score.
4. **Ambiguous** — more than one candidate survives, or two identifiers in one
   reference point at different records. ``AMBIGUOUS_MATCH``.
5. **No candidate** — nothing matches. ``NO_MATCH_NEW_ENTITY``.

Rungs 4 and 5 both mean "a person decides", but they are different reasons and
are reported as different reasons. Nothing here merges two people, and nothing
here creates an entity.

No fuzzy name matching is performed, deliberately: on a 500-person corpus with
500 distinct names, an edit-distance match would be a guess dressed as a link.
"""
from __future__ import annotations

from typing import Any, Optional

from app.config import Settings
from app.graph.model import location_eid, person_eid
from app.ingest.models import (
    CandidateMatch,
    EntityMatch,
    MatchMethod,
    MatchStatus,
)
from app.ingest.normalize import reference_label
from app.nlp import normalizer as norm
from app.nlp.models import CONF_RES_FIR_CONTEXT, CONF_RES_IDENTIFIER, CONF_RES_UNIQUE_NAME

# How many candidate ids a review payload carries. A city can legitimately have
# thirty location rows; listing all of them helps nobody read the decision.
MAX_CANDIDATES = 10


class IngestResolver:
    """Resolves submitted references against the existing records.

    Reads the repository's person and location records and never writes. This
    phase creates no entities — a new person or place requires an investigator's
    decision, which §6 deliberately leaves outside the automated path — so the
    indexes are built once and stay valid for the life of the process.
    """

    def __init__(self, repo, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings
        self._by_person_id: dict[int, dict] = {}
        self._by_phone: dict[str, list[dict]] = {}
        self._by_aadhaar: dict[str, list[dict]] = {}
        self._by_name: dict[str, list[dict]] = {}
        self._by_place: dict[str, list[dict]] = {}
        self._locations_by_id: dict[int, dict] = {}
        self.reindex()

    # -- indexes -----------------------------------------------------------
    def reindex(self) -> None:
        """Build the lookup indexes from the current record view."""

        self._by_person_id = {}
        self._by_phone = {}
        self._by_aadhaar = {}
        self._by_name = {}
        for person in self.repo.persons:
            self._by_person_id[int(person["person_id"])] = person
            self._by_phone.setdefault(
                norm.normalize_phone(person["phone"]), []
            ).append(person)
            self._by_aadhaar.setdefault(
                norm.normalize_aadhaar(person["aadhar"]), []
            ).append(person)
            self._by_name.setdefault(
                norm.normalize_name(person["name"]).casefold(), []
            ).append(person)

        self._by_place = {}
        self._locations_by_id = {}
        for loc in self.repo.locations:
            self._locations_by_id[int(loc["location_id"])] = loc
            city = norm.normalize_whitespace(loc["city"])
            state = norm.normalize_whitespace(loc["state"])
            if city and state:
                self._by_place.setdefault(f"{city}, {state}".casefold(), []).append(loc)

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _person_candidates(records: list[dict]) -> list[CandidateMatch]:
        ordered = sorted(records, key=lambda r: int(r["person_id"]))[:MAX_CANDIDATES]
        return [
            CandidateMatch(
                entity_id=person_eid(int(r["person_id"])),
                label=r["name"],
                detail={"city": r["city"], "state": r["state"]},
            )
            for r in ordered
        ]

    @staticmethod
    def _location_candidates(records: list[dict]) -> list[CandidateMatch]:
        ordered = sorted(records, key=lambda r: int(r["location_id"]))[:MAX_CANDIDATES]
        return [
            CandidateMatch(
                entity_id=location_eid(int(r["location_id"])),
                label=f"{r['city']}, {r['state']}",
            )
            for r in ordered
        ]

    def person_record(self, entity_id: str) -> Optional[dict]:
        if not entity_id.startswith("person:"):
            return None
        try:
            return self._by_person_id.get(int(entity_id.split(":", 1)[1]))
        except ValueError:  # pragma: no cover - ids are built, not parsed, upstream
            return None

    def location_record(self, location_id: int) -> Optional[dict]:
        return self._locations_by_id.get(int(location_id))

    # -- persons -----------------------------------------------------------
    def resolve_person(
        self,
        reference: dict[str, Any],
        field_name: str,
        *,
        place: Optional[dict[str, Any]] = None,
    ) -> EntityMatch:
        """Walk the ladder for one person reference."""
        label = reference_label(reference)

        # --- rung 1: trusted identifiers, intersected when several are given.
        identifier_sets: list[tuple[str, list[dict]]] = []
        if "person_id" in reference:
            record = self._by_person_id.get(int(reference["person_id"]))
            identifier_sets.append(("person_id", [record] if record else []))
        if "phone" in reference:
            identifier_sets.append(("phone", self._by_phone.get(reference["phone"], [])))
        if "aadhaar" in reference:
            identifier_sets.append(
                ("aadhaar", self._by_aadhaar.get(reference["aadhaar"], []))
            )

        if identifier_sets:
            found = [(key, recs) for key, recs in identifier_sets if recs]
            if not found:
                return EntityMatch(
                    field_name=field_name,
                    status=MatchStatus.NO_MATCH,
                    method=MatchMethod.NONE,
                    is_new_entity=True,
                    explanation=(
                        f"No existing person carries this {label}; treated as a new "
                        "subject rather than matched to anyone."
                    ),
                )
            id_sets = [{int(r["person_id"]) for r in recs} for _, recs in found]
            common: set[int] = set.intersection(*id_sets) if id_sets else set()
            if len(common) == 1:
                record = self._by_person_id[next(iter(common))]
                keys = ", ".join(key for key, _ in found)
                return EntityMatch(
                    field_name=field_name,
                    status=MatchStatus.MATCHED,
                    method=MatchMethod.TRUSTED_IDENTIFIER,
                    entity_id=person_eid(int(record["person_id"])),
                    label=record["name"],
                    confidence=CONF_RES_IDENTIFIER,
                    explanation=f"Matched on trusted identifier ({keys}).",
                )
            # Either one identifier is shared by several records, or two
            # identifiers on this reference name different people. Both are
            # "we cannot tell which person this is" — never a silent merge.
            merged: dict[int, dict] = {}
            for _, recs in found:
                for record in recs:
                    merged[int(record["person_id"])] = record
            conflict = len(found) > 1 and not common
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.AMBIGUOUS,
                method=MatchMethod.TRUSTED_IDENTIFIER,
                candidates=self._person_candidates(list(merged.values())),
                explanation=(
                    "The identifiers on this reference match different person "
                    "records; not merged without a decision."
                    if conflict
                    else f"{len(merged)} person records match this {label}."
                ),
            )

        # --- rung 2: normalized exact name.
        name = reference.get("name")
        if not name:  # pragma: no cover - normalization guarantees one key
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.NO_MATCH,
                method=MatchMethod.NONE,
                explanation="No usable identifier on this reference.",
                is_new_entity=True,
            )
        matches = self._by_name.get(norm.normalize_name(name).casefold(), [])
        if not matches:
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.NO_MATCH,
                method=MatchMethod.NONE,
                is_new_entity=True,
                explanation=(
                    f"No existing person is recorded under the name {name!r}. "
                    "No approximate name matching is attempted."
                ),
            )
        if len(matches) == 1:
            record = matches[0]
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.MATCHED,
                method=MatchMethod.NORMALIZED_EXACT,
                entity_id=person_eid(int(record["person_id"])),
                label=record["name"],
                confidence=CONF_RES_UNIQUE_NAME,
                explanation="Matched on an exact normalized name (one record).",
            )

        # --- rung 3: the place named on this record narrows a shared name.
        if place:
            city = norm.normalize_whitespace(str(place.get("city") or ""))
            state = norm.normalize_whitespace(str(place.get("state") or ""))
            if not city and place.get("location_id") is not None:
                row = self.location_record(int(place["location_id"]))
                if row:
                    city, state = row["city"], row["state"]
            if city:
                narrowed = [
                    r
                    for r in matches
                    if r["city"].casefold() == city.casefold()
                    and (not state or r["state"].casefold() == state.casefold())
                ]
                if len(narrowed) == 1:
                    record = narrowed[0]
                    return EntityMatch(
                        field_name=field_name,
                        status=MatchStatus.MATCHED,
                        method=MatchMethod.DETERMINISTIC_CONTEXT,
                        entity_id=person_eid(int(record["person_id"])),
                        label=record["name"],
                        confidence=CONF_RES_FIR_CONTEXT,
                        candidates=self._person_candidates(matches),
                        explanation=(
                            f"{len(matches)} people share this name; the place named "
                            "on this record singles one out."
                        ),
                    )

        return EntityMatch(
            field_name=field_name,
            status=MatchStatus.AMBIGUOUS,
            method=MatchMethod.NORMALIZED_EXACT,
            candidates=self._person_candidates(matches),
            explanation=(
                f"{len(matches)} people share the name {name!r} and this record "
                "does not single one out; left for a decision rather than merged."
            ),
        )

    # -- places ------------------------------------------------------------
    def resolve_place(
        self,
        place: dict[str, Any],
        field_name: str = "place",
        *,
        anchor_person: Optional[dict] = None,
    ) -> EntityMatch:
        """Resolve a city/state (or explicit ``location_id``) to a LOCATION node.

        Ten distinct city/state pairs cover two hundred location rows in this
        corpus, so a place given only by name is genuinely ambiguous. When the
        record references a person, that person's own location row is the
        deterministic corroborator — the same trick Phase 3 plays with the FIR's
        ``location_id``. No coordinate is ever invented for an unknown place.
        """
        location_id = place.get("location_id")
        if location_id is not None:
            row = self.location_record(int(location_id))
            if row is None:
                return EntityMatch(
                    field_name=field_name,
                    status=MatchStatus.NO_MATCH,
                    method=MatchMethod.NONE,
                    is_new_entity=True,
                    explanation=f"No location record {int(location_id)} exists.",
                )
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.MATCHED,
                method=MatchMethod.TRUSTED_IDENTIFIER,
                entity_id=location_eid(int(row["location_id"])),
                label=f"{row['city']}, {row['state']}",
                confidence=CONF_RES_IDENTIFIER,
                explanation="Matched on an existing location_id.",
            )

        city = norm.normalize_whitespace(str(place.get("city") or ""))
        state = norm.normalize_whitespace(str(place.get("state") or ""))
        matches = self._by_place.get(f"{city}, {state}".casefold(), [])
        if not matches:
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.NO_MATCH,
                method=MatchMethod.NONE,
                is_new_entity=True,
                explanation=(
                    f"{city}, {state} is not an existing location in this "
                    "investigation; no coordinates are inferred for it."
                ),
            )
        if len(matches) == 1:
            row = matches[0]
            return EntityMatch(
                field_name=field_name,
                status=MatchStatus.MATCHED,
                method=MatchMethod.NORMALIZED_EXACT,
                entity_id=location_eid(int(row["location_id"])),
                label=f"{row['city']}, {row['state']}",
                confidence=CONF_RES_UNIQUE_NAME,
                explanation="Matched one location record for this city and state.",
            )

        if anchor_person is not None:
            anchor_id = int(anchor_person["location_id"])
            if any(int(r["location_id"]) == anchor_id for r in matches):
                row = self._locations_by_id[anchor_id]
                return EntityMatch(
                    field_name=field_name,
                    status=MatchStatus.MATCHED,
                    method=MatchMethod.DETERMINISTIC_CONTEXT,
                    entity_id=location_eid(anchor_id),
                    label=f"{row['city']}, {row['state']}",
                    confidence=CONF_RES_FIR_CONTEXT,
                    candidates=self._location_candidates(matches),
                    explanation=(
                        f"{len(matches)} location records share this city and state; "
                        "the referenced person's own recorded location singles one out."
                    ),
                )

        return EntityMatch(
            field_name=field_name,
            status=MatchStatus.AMBIGUOUS,
            method=MatchMethod.NORMALIZED_EXACT,
            candidates=self._location_candidates(matches),
            explanation=(
                f"{len(matches)} location records share {city}, {state}; supply a "
                "location_id to say which one."
            ),
        )
