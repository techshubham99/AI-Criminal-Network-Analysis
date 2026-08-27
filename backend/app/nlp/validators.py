"""Deterministic validation gates for the NLP pipeline (Phase 3 spec §1, §6, §10).

Nothing here guesses. Each function answers one narrow question with a fixed
rule, and the failure branch always returns a human-readable *reason* so the API
can explain why an entity was dropped, a resolution left unresolved, or a
relationship refused.

Two deliberate calibration notes, both measured against the actual dataset:

* **Aadhaar** is validated as *exactly 12 digits* — nothing more. The UIDAI
  convention that the first digit is 2-9 does NOT hold in this synthetic corpus
  (36 of 500 ``persons.aadhar`` values begin with ``1``), so enforcing it would
  silently discard real records. Format plausibility only; no checksum.
* **Person names** use a conservative shape rule (1-4 capitalised tokens). All
  500 dataset names satisfy it; it is intentionally strict so the extractor
  never promotes an arbitrary capitalised phrase to a PERSON.
"""
from __future__ import annotations

import re

from app.nlp.models import (
    EntityType,
    ExtractedEntity,
    NarrativeRelationship,
)

_DIGITS_RE = re.compile(r"\A\d+\Z")
_ISO_DATE_RE = re.compile(r"\A\d{4}-\d{2}-\d{2}\Z")
_MONEY_RE = re.compile(r"\A\d+(?:\.\d+)?\Z")
# 1-4 tokens, each starting uppercase; internal hyphen/apostrophe allowed.
_NAME_RE = re.compile(r"\A[A-Z][a-zA-Z'\-]*(?: [A-Z][a-zA-Z'\-]*){0,3}\Z")
# "City, State" or a bare city; letters/spaces/hyphens only.
_LOCATION_RE = re.compile(r"\A[A-Z][a-zA-Z\-]*(?: [A-Z][a-zA-Z\-]*)*(?:, [A-Z][a-zA-Z\-]*(?: [A-Z][a-zA-Z\-]*)*)?\Z")

MIN_NAME_TOKEN_LEN = 2


def is_valid_phone10(value: str) -> bool:
    """True for a national 10-digit Indian mobile number (leading digit 6-9)."""
    return len(value) == 10 and value[0] in "6789" and bool(_DIGITS_RE.match(value))


def is_valid_aadhaar(value: str) -> bool:
    """True for exactly 12 digits. Format plausibility only (see module docstring)."""
    return len(value) == 12 and bool(_DIGITS_RE.match(value))


def is_iso_date(value: str) -> bool:
    """True only for a real calendar date already normalized to ``YYYY-MM-DD``."""
    if not _ISO_DATE_RE.match(value):
        return False
    from datetime import datetime

    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def is_valid_money(value: str) -> bool:
    """True for a bare non-negative numeric amount (normalizer output)."""
    return bool(_MONEY_RE.match(value)) and float(value) > 0


def is_plausible_person_name(value: str) -> bool:
    """Conservative name shape test (see module docstring)."""
    if not _NAME_RE.match(value):
        return False
    return all(len(tok) >= MIN_NAME_TOKEN_LEN for tok in value.split(" "))


def is_plausible_location(value: str) -> bool:
    """Conservative ``"City, State"`` / bare-city shape test."""
    return bool(_LOCATION_RE.match(value))


# --- entity-level gate ------------------------------------------------------
def validate_entity(entity: ExtractedEntity, narrative: str) -> tuple[bool, str | None]:
    """Return ``(ok, reason)`` for one extracted entity.

    Checks, in order: character span integrity (the span must reproduce
    ``raw_text`` exactly), confidence range, non-empty normalized value, and the
    per-type format rule. Any failure is a hard drop — the extractor never emits
    an entity it cannot substantiate.
    """
    if entity.character_start < 0 or entity.character_end > len(narrative):
        return False, "character span outside narrative bounds"
    if entity.character_end <= entity.character_start:
        return False, "empty character span"
    if narrative[entity.character_start : entity.character_end] != entity.raw_text:
        return False, "character span does not reproduce raw_text"
    if not 0.0 < entity.confidence <= 1.0:
        return False, "confidence outside (0.0, 1.0]"
    if not entity.normalized_value:
        return False, "empty normalized_value"
    if not entity.evidence_text:
        return False, "empty evidence_text"

    et, value = entity.entity_type, entity.normalized_value
    if et is EntityType.PHONE and not is_valid_phone10(value):
        return False, "phone is not a valid 10-digit national number"
    if et is EntityType.AADHAAR and not is_valid_aadhaar(value):
        return False, "aadhaar is not exactly 12 digits"
    if et is EntityType.DATE and not is_iso_date(value):
        return False, "date is not a valid ISO calendar date"
    if et is EntityType.MONEY and not is_valid_money(value):
        return False, "money is not a positive numeric amount"
    if et is EntityType.PERSON and not is_plausible_person_name(value):
        return False, "text does not match the conservative person-name shape"
    if et is EntityType.LOCATION and not is_plausible_location(value):
        return False, "text does not match the conservative location shape"
    return True, None


# --- relationship-level gate ------------------------------------------------
def validate_relationship(
    rel: NarrativeRelationship, narrative: str
) -> tuple[bool, str | None]:
    """Return ``(ok, reason)`` for one candidate narrative relationship (spec §6).

    A relationship must carry a real evidence span, a confidence in ``(0, 1]``,
    correct ``fir_text`` provenance, and non-empty endpoint mentions. Two things
    are deliberately NOT checked here:

    * **Endpoint resolution** — unresolved endpoints are legitimate extraction
      output (they are reported; only *graph integration* refuses them, spec §7).
    * **Self-loops** — when a FIR names the same person as complainant and
      suspect (fir_id 162 in this dataset), that IS what the narrative asserts.
      Dropping it here would hide it; instead integration rejects it with
      ``REJECTED_SELF_LOOP`` so ``/graph-impact`` can explain the decision.
    """
    if rel.character_start < 0 or rel.character_end > len(narrative):
        return False, "character span outside narrative bounds"
    if rel.character_end <= rel.character_start:
        return False, "empty character span"
    if not rel.evidence_text.strip():
        return False, "empty evidence_text"
    if not 0.0 < rel.confidence <= 1.0:
        return False, "confidence outside (0.0, 1.0]"
    if rel.source_dataset != "fir_text":
        return False, "narrative relationship must declare source_dataset='fir_text'"
    if rel.source_record_id != f"firs:{rel.fir_id}":
        return False, "source_record_id must be 'firs:{fir_id}'"
    if not rel.source_mention or not rel.target_mention:
        return False, "missing endpoint mention text"
    return True, None
