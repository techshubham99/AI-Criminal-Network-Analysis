"""Rules-first, fully deterministic entity extraction from FIR narratives.

Phase 3 spec §2/§3. Three complementary, ordered strategies — no statistical
model, no external service, no downloaded artefacts:

1. **Strict-format regex** for structured identifiers: PHONE, AADHAAR, DATE,
   MONEY, VEHICLE (registration plate). A match is only accepted if the
   normalized value passes :mod:`app.nlp.validators`.
2. **Known-record matching (gazetteer)** built from the loaded structured
   dataset: the 500 ``persons.name`` values and the ``locations`` city/state
   pairs. A mention that equals a known record is high-confidence *because it is
   corroborated by structured data*, not because a model said so.
3. **Template anchors** for mentions that are positionally identified but NOT
   present in the structured records (e.g. ``"Suspect <Unknown Name> (Phone …)"``,
   ``"at <Unknown City>, <Unknown State>"``, an organisation legal suffix). These
   get the lower :data:`~app.nlp.models.CONF_ANCHORED_ONLY` tier.

Confidence invariant (asserted in tests): ``extraction_method == REGEX`` implies
a strict, self-validating format and therefore confidence ``1.0``;
``KNOWN_RECORD`` implies structured corroboration and confidence ``1.0``;
``ANCHORED_PATTERN`` implies position-only evidence and confidence ``0.6``.

Honesty note (spec §3): this corpus is template-generated and its narratives
mostly *restate* structured fields. This module is therefore best understood as
a text→structured *linking* layer whose precision is a property of the template,
not evidence of real-world NLP accuracy. VEHICLE, ORGANIZATION and MONEY rules
are implemented but match **zero** times across all 300 narratives; that zero is
reported as-is rather than hidden.

Extensibility (spec §3): a future *local* ML/LLM extractor plugs in as a
:class:`SupplementalExtractor`. Its proposals pass through the same span-dedup
and validator gate as the rules, so it can add coverage but cannot corrupt the
deterministic core. spaCy is deliberately NOT a dependency —
:func:`spacy_available` exists only so the absence is explicit and the rule path
is documented as the always-available fallback.
"""
from __future__ import annotations

import importlib.util
import re
from bisect import bisect_right
from dataclasses import dataclass
from typing import Iterable, Optional, Protocol, Sequence, runtime_checkable

from app.nlp import normalizer as norm
from app.nlp import validators
from app.nlp.models import (
    CONF_ANCHORED_ONLY,
    CONF_KNOWN_RECORD,
    CONF_REGEX_STRUCTURED,
    EntityType,
    ExtractedEntity,
    ExtractionMethod,
)

# --- role vocabulary --------------------------------------------------------
ROLE_COMPLAINANT = "complainant"
ROLE_ACCUSED = "accused"

_ROLE_KEYWORDS: dict[str, str] = {
    "suspect": ROLE_ACCUSED,
    "accused": ROLE_ACCUSED,
    "complainant": ROLE_COMPLAINANT,
    "victim": ROLE_COMPLAINANT,
}
# A reporting verb shortly after a name implies the complainant role. Kept as an
# explicit closed list rather than a stem+`\w*` pattern, which would fire on
# unrelated words ("field", "filter").
_REPORTING_CUE_RE = REPORTING_VERB_RE = re.compile(
    r"\b(?:reported|reports|reporting|lodged|lodges|filed|files|filing|complained)\b",
    re.IGNORECASE,
)
_REPORTING_CUE_WINDOW = 48  # characters after the name span

# --- strict-format patterns -------------------------------------------------
# Indian mobile: optional +91/91/0 prefix, then a 10-digit number starting 6-9.
# The lookarounds prevent matching a slice of a longer digit run (e.g. Aadhaar).
PHONE_RE = re.compile(r"(?<!\d)(?:\+?91[-\s]?|0)?(?:[6-9]\d{9})(?!\d)")
# Aadhaar: 12 digits, optionally grouped 4-4-4 by a single space or hyphen.
AADHAAR_RE = re.compile(r"(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)")
DATE_RE = re.compile(
    r"(?<!\d)(?:"
    r"\d{4}-\d{2}-\d{2}"                      # 2026-06-08
    r"|\d{1,2}[-/]\d{1,2}[-/]\d{4}"           # 08-06-2026, 8/6/2026
    r"|\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}"     # 8 June 2026
    r"|[A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4}"    # June 8, 2026
    r")(?!\d)"
)
# Money: an explicit currency marker is REQUIRED. Multiplier words (lakh/crore)
# are deliberately not matched — expanding them would assert a magnitude the
# text does not literally state.
MONEY_RE = re.compile(
    r"(?:₹|Rs\.?|INR)\s*\d[\d,]*(?:\.\d+)?"
    r"|\d[\d,]*(?:\.\d+)?\s*(?:rupees|Rupees)\b"
)
# Indian vehicle registration plate, e.g. "MH 12 AB 1234" / "DL-01-C-4567".
VEHICLE_RE = re.compile(r"\b[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{4}\b")

# --- template anchors -------------------------------------------------------
_NAME_TOKEN = r"[A-Z][A-Za-z'\-]+"
# Tokens that are capitalised and may sit directly in front of a name, but are
# never part of it. Without this guard the greedy _NAME in NAME_BEFORE_ID_RE
# swallows the role keyword ("Suspect Gunbir Sankar (Phone …)") and the mention
# then fails to match any known person record.
_NON_NAME_LEADING = (
    "Suspect", "Suspects", "Accused", "Complainant", "Victim", "Witness",
    "Mr", "Mrs", "Ms", "Miss", "Shri", "Smt", "Sri", "Dr", "Sh",
)
_NOT_LEADING = r"(?!(?:" + "|".join(_NON_NAME_LEADING) + r")\b)"
_NAME = rf"{_NAME_TOKEN}(?:\s{_NAME_TOKEN}){{0,3}}"
_NAME_NO_PREFIX = rf"{_NOT_LEADING}{_NAME_TOKEN}(?:\s{_NAME_TOKEN}){{0,3}}"
# "<Name> (Aadhar 3161…)" / "<Name> (Phone +91-…)": a name immediately before an
# identifier parenthetical.
NAME_BEFORE_ID_RE = re.compile(
    rf"({_NAME_NO_PREFIX})\s*\(\s*(?:Aadhar|Aadhaar|UID|Phone|Mobile|Mob|Ph)\b",
)
# "Suspect <Name>" / "Complainant <Name>". Case variants are spelled out instead
# of using re.IGNORECASE, which would also relax the `[A-Z]` in _NAME and let a
# lowercase phrase ("suspect the man") be captured as a name.
ROLE_PREFIX_NAME_RE = re.compile(
    rf"\b(?P<kw>[Ss]uspect|[Aa]ccused|[Cc]omplainant|[Vv]ictim)\s+(?P<name>{_NAME_NO_PREFIX})",
)
_PLACE_TOKEN = r"[A-Z][A-Za-z\-]+"
_PLACE = rf"{_PLACE_TOKEN}(?:\s{_PLACE_TOKEN})*"
# "at <City>, <State>" — the comma form is required to stay conservative.
PLACE_ANCHOR_RE = re.compile(rf"\b(?:at|in|near)\s+({_PLACE},\s*{_PLACE})")
# An organisation is only claimed when a legal/entity suffix is literally present.
ORG_RE = re.compile(
    r"\b(?:[A-Z][A-Za-z&.\-]*\s+){0,4}"
    r"(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Ltd\.?|LLP|Bank|Enterprises|Traders|"
    r"Corporation|Industries|Agency|Society|Association|Trust|Foundation)\b"
)

# Abbreviations whose trailing period is not a sentence boundary. Without this,
# "transferred Rs. 5,000 to <name>" splits mid-sentence, which truncates
# evidence_text and suppresses any relationship whose trigger and endpoints then
# land in different "sentences". No narrative in this dataset contains one of
# these, so the guard changes nothing for the supplied corpus.
_ABBREVIATIONS = ("Rs", "No", "Mr", "Mrs", "Ms", "Dr", "Smt", "Shri", "St", "Sr", "Jr", "vs")
_SENTENCE_SPLIT_RE = re.compile(
    r"(?<=[.!?])"
    + "".join(rf"(?<!\b{abbr}\.)" for abbr in _ABBREVIATIONS)
    + r"\s+"
)

# --- candidate priorities (higher wins when spans overlap) -------------------
_PRIO_IDENTIFIER = 60   # phone / aadhaar
_PRIO_FORMAT = 50       # date / money / vehicle
_PRIO_PLACE_PAIR = 45   # known "City, State"
_PRIO_ANCHOR = 40       # name anchors, "at X, Y" anchor
_PRIO_PLACE_CITY = 35   # known bare city
_PRIO_NAME_SCAN = 30    # known person name found anywhere
_PRIO_ORG = 20

_METHOD_RANK: dict[ExtractionMethod, int] = {
    ExtractionMethod.REGEX: 0,
    ExtractionMethod.KNOWN_RECORD: 1,
    ExtractionMethod.ANCHORED_PATTERN: 2,
}


@runtime_checkable
class SupplementalExtractor(Protocol):
    """Optional future extractor (e.g. a local ML model). See module docstring."""

    name: str

    def propose(self, fir_id: int, narrative: str) -> Sequence[ExtractedEntity]:
        ...


def spacy_available() -> bool:
    """True if spaCy happens to be importable. Phase 3 never requires it."""
    return importlib.util.find_spec("spacy") is not None


@dataclass(frozen=True)
class _Candidate:
    entity: ExtractedEntity
    priority: int


class EntityExtractor:
    """Deterministic entity extractor over a loaded :class:`DatasetRepository`.

    The gazetteers are built once at construction, so extraction is O(len(text))
    per narrative and produces byte-identical output on every run.
    """

    def __init__(self, repo, supplements: Sequence[SupplementalExtractor] = ()) -> None:
        self.repo = repo
        self.supplements = tuple(supplements)
        self.dropped: list[tuple[int, str, str]] = []  # (fir_id, raw_text, reason)

        # --- person-name gazetteer -----------------------------------------
        self._person_names: dict[str, list[int]] = {}
        for p in repo.persons:
            key = norm.normalize_name(p["name"]).casefold()
            self._person_names.setdefault(key, []).append(p["person_id"])
        # Longest-first alternation so "Ravi Kumar Singh" beats "Ravi Kumar".
        names_sorted = sorted(
            {norm.normalize_name(p["name"]) for p in repo.persons},
            key=lambda n: (-len(n), n),
        )
        self._name_scan_re = (
            re.compile(r"\b(?:" + "|".join(re.escape(n) for n in names_sorted) + r")\b")
            if names_sorted
            else None
        )

        # --- location gazetteer --------------------------------------------
        pairs: set[str] = set()
        cities: set[str] = set()
        self._pair_index: dict[str, list[int]] = {}
        self._city_index: dict[str, list[int]] = {}
        for loc in repo.locations:
            city = norm.normalize_whitespace(loc["city"])
            state = norm.normalize_whitespace(loc["state"])
            if not city:
                continue
            cities.add(city)
            self._city_index.setdefault(city.casefold(), []).append(loc["location_id"])
            if state:
                pair = f"{city}, {state}"
                pairs.add(pair)
                self._pair_index.setdefault(pair.casefold(), []).append(loc["location_id"])
        self._pair_scan_re = (
            re.compile(
                r"\b(?:"
                + "|".join(re.escape(p) for p in sorted(pairs, key=lambda s: (-len(s), s)))
                + r")\b"
            )
            if pairs
            else None
        )
        self._city_scan_re = (
            re.compile(
                r"\b(?:"
                + "|".join(re.escape(c) for c in sorted(cities, key=lambda s: (-len(s), s)))
                + r")\b"
            )
            if cities
            else None
        )

    # -- gazetteer queries (used by the resolver too) ------------------------
    def person_ids_for_name(self, name: str) -> list[int]:
        return list(self._person_names.get(norm.normalize_name(name).casefold(), ()))

    def location_ids_for_place(self, place: str) -> list[int]:
        key = norm.normalize_location(place).casefold()
        if key in self._pair_index:
            return list(self._pair_index[key])
        return list(self._city_index.get(key, ()))

    def is_known_place(self, place: str) -> bool:
        return bool(self.location_ids_for_place(place))

    # -- extraction ---------------------------------------------------------
    def extract(self, fir_id: int, narrative: str) -> list[ExtractedEntity]:
        """Extract every substantiated entity mention from one narrative.

        Returns entities sorted by ``(character_start, character_end, type)`` so
        the API output is stable. Candidates that fail
        :func:`app.nlp.validators.validate_entity` are dropped and recorded on
        ``self.dropped`` for the evaluation report.
        """
        if not narrative:
            return []
        sentences = _sentence_spans(narrative)
        candidates: list[_Candidate] = []
        candidates.extend(self._structured_candidates(fir_id, narrative, sentences))
        candidates.extend(self._person_candidates(fir_id, narrative, sentences))
        candidates.extend(self._location_candidates(fir_id, narrative, sentences))
        candidates.extend(self._org_candidates(fir_id, narrative, sentences))
        for plugin in self.supplements:
            for proposed in plugin.propose(fir_id, narrative):
                candidates.append(_Candidate(proposed, _PRIO_NAME_SCAN))

        kept = self._resolve_overlaps(candidates, narrative)
        return sorted(
            kept,
            key=lambda e: (e.character_start, e.character_end, e.entity_type.value),
        )

    # -- strategy 1: strict formats -----------------------------------------
    def _structured_candidates(
        self, fir_id: int, text: str, sentences: list[tuple[int, int]]
    ) -> Iterable[_Candidate]:
        specs = (
            (AADHAAR_RE, EntityType.AADHAAR, norm.normalize_aadhaar, _PRIO_IDENTIFIER),
            (PHONE_RE, EntityType.PHONE, norm.normalize_phone, _PRIO_IDENTIFIER),
            (DATE_RE, EntityType.DATE, norm.normalize_date, _PRIO_FORMAT),
            (MONEY_RE, EntityType.MONEY, norm.normalize_money, _PRIO_FORMAT),
            (VEHICLE_RE, EntityType.VEHICLE, norm.normalize_whitespace, _PRIO_FORMAT),
        )
        for pattern, etype, normalize, priority in specs:
            for m in pattern.finditer(text):
                raw = m.group(0)
                yield _Candidate(
                    ExtractedEntity(
                        entity_type=etype,
                        raw_text=raw,
                        normalized_value=normalize(raw),
                        confidence=CONF_REGEX_STRUCTURED,
                        fir_id=fir_id,
                        character_start=m.start(),
                        character_end=m.end(),
                        extraction_method=ExtractionMethod.REGEX,
                        evidence_text=_evidence(text, sentences, m.start()),
                    ),
                    priority,
                )

    # -- strategy 2+3: persons ----------------------------------------------
    def _person_candidates(
        self, fir_id: int, text: str, sentences: list[tuple[int, int]]
    ) -> Iterable[_Candidate]:
        seen_spans: set[tuple[int, int]] = set()

        def make(start: int, end: int, priority: int, role: Optional[str]) -> _Candidate:
            raw = text[start:end]
            known = bool(self.person_ids_for_name(raw))
            return _Candidate(
                ExtractedEntity(
                    entity_type=EntityType.PERSON,
                    raw_text=raw,
                    normalized_value=norm.normalize_name(raw),
                    confidence=CONF_KNOWN_RECORD if known else CONF_ANCHORED_ONLY,
                    fir_id=fir_id,
                    character_start=start,
                    character_end=end,
                    extraction_method=(
                        ExtractionMethod.KNOWN_RECORD if known
                        else ExtractionMethod.ANCHORED_PATTERN
                    ),
                    evidence_text=_evidence(text, sentences, start),
                    role=role,
                ),
                priority,
            )

        # Role-prefixed names ("Suspect X"): role is stated in the text.
        for m in ROLE_PREFIX_NAME_RE.finditer(text):
            role = _ROLE_KEYWORDS.get(m.group("kw").casefold())
            span = self._narrow_to_known_person(text, m.start("name"), m.end("name"))
            if span in seen_spans:
                continue
            seen_spans.add(span)
            yield make(span[0], span[1], _PRIO_ANCHOR, role)

        # Names immediately before an identifier parenthetical.
        for m in NAME_BEFORE_ID_RE.finditer(text):
            span = self._narrow_to_known_person(text, m.start(1), m.end(1))
            if span in seen_spans:
                continue
            seen_spans.add(span)
            yield make(span[0], span[1], _PRIO_ANCHOR, self._infer_role(text, span[1]))

        # Known names anywhere else in the text.
        if self._name_scan_re is not None:
            for m in self._name_scan_re.finditer(text):
                span = (m.start(), m.end())
                if span in seen_spans:
                    continue
                seen_spans.add(span)
                yield make(span[0], span[1], _PRIO_NAME_SCAN, self._infer_role(text, span[1]))

    def _narrow_to_known_person(self, text: str, start: int, end: int) -> tuple[int, int]:
        """Trim leading tokens until the span equals a known person record.

        Second, independent guard against an anchor over-capturing a preceding
        capitalised word (an honorific, a role keyword, or a sentence-initial
        word). Returns the LONGEST suffix of the span that matches a structured
        record; if no suffix matches, the span is returned unchanged and the
        mention stays at the lower ANCHORED_PATTERN confidence tier.
        """
        if self.person_ids_for_name(text[start:end]):
            return start, end
        token_offsets = [m.start() for m in re.finditer(r"\S+", text[start:end])]
        for offset in token_offsets[1:]:
            candidate_start = start + offset
            if self.person_ids_for_name(text[candidate_start:end]):
                return candidate_start, end
        return start, end

    @staticmethod
    def _infer_role(text: str, name_end: int) -> Optional[str]:
        """Read a role from explicit cues around the name; ``None`` if unstated."""
        window = text[name_end : name_end + _REPORTING_CUE_WINDOW]
        if _REPORTING_CUE_RE.search(window):
            return ROLE_COMPLAINANT
        return None

    # -- strategy 2+3: locations --------------------------------------------
    def _location_candidates(
        self, fir_id: int, text: str, sentences: list[tuple[int, int]]
    ) -> Iterable[_Candidate]:
        def make(start: int, end: int, priority: int) -> _Candidate:
            raw = text[start:end]
            known = self.is_known_place(raw)
            return _Candidate(
                ExtractedEntity(
                    entity_type=EntityType.LOCATION,
                    raw_text=raw,
                    normalized_value=norm.normalize_location(raw),
                    confidence=CONF_KNOWN_RECORD if known else CONF_ANCHORED_ONLY,
                    fir_id=fir_id,
                    character_start=start,
                    character_end=end,
                    extraction_method=(
                        ExtractionMethod.KNOWN_RECORD if known
                        else ExtractionMethod.ANCHORED_PATTERN
                    ),
                    evidence_text=_evidence(text, sentences, start),
                ),
                priority,
            )

        if self._pair_scan_re is not None:
            for m in self._pair_scan_re.finditer(text):
                yield make(m.start(), m.end(), _PRIO_PLACE_PAIR)
        for m in PLACE_ANCHOR_RE.finditer(text):
            yield make(m.start(1), m.end(1), _PRIO_ANCHOR)
        if self._city_scan_re is not None:
            for m in self._city_scan_re.finditer(text):
                yield make(m.start(), m.end(), _PRIO_PLACE_CITY)

    # -- strategy 3: organisations ------------------------------------------
    def _org_candidates(
        self, fir_id: int, text: str, sentences: list[tuple[int, int]]
    ) -> Iterable[_Candidate]:
        for m in ORG_RE.finditer(text):
            start, end = m.start(), m.end()
            yield _Candidate(
                ExtractedEntity(
                    entity_type=EntityType.ORGANIZATION,
                    raw_text=text[start:end],
                    normalized_value=norm.normalize_whitespace(m.group(0)),
                    confidence=CONF_ANCHORED_ONLY,
                    fir_id=fir_id,
                    character_start=start,
                    character_end=end,
                    extraction_method=ExtractionMethod.ANCHORED_PATTERN,
                    evidence_text=_evidence(text, sentences, start),
                ),
                _PRIO_ORG,
            )

    # -- overlap resolution + validation ------------------------------------
    def _resolve_overlaps(
        self, candidates: list[_Candidate], narrative: str
    ) -> list[ExtractedEntity]:
        """Keep the strongest candidate per text region; drop invalid ones.

        Deterministic ordering: earliest start, then higher priority, then longer
        span, then role-bearing, then method rank, then type name. An accepted
        span blocks any later candidate that overlaps it.
        """
        ordered = sorted(
            candidates,
            key=lambda c: (
                c.entity.character_start,
                -c.priority,
                -(c.entity.character_end - c.entity.character_start),
                0 if c.entity.role else 1,
                _METHOD_RANK[c.entity.extraction_method],
                c.entity.entity_type.value,
            ),
        )
        accepted: list[ExtractedEntity] = []
        taken: list[tuple[int, int]] = []
        for cand in ordered:
            e = cand.entity
            if any(s < e.character_end and e.character_start < t for s, t in taken):
                continue
            ok, reason = validators.validate_entity(e, narrative)
            if not ok:
                self.dropped.append((e.fir_id, e.raw_text, reason or "invalid"))
                continue
            accepted.append(e)
            taken.append((e.character_start, e.character_end))
        return accepted


# --- helpers ----------------------------------------------------------------
def _sentence_spans(text: str) -> list[tuple[int, int]]:
    """Split into sentence spans on terminal punctuation + whitespace."""
    spans: list[tuple[int, int]] = []
    start = 0
    for m in _SENTENCE_SPLIT_RE.finditer(text):
        spans.append((start, m.start()))
        start = m.end()
    spans.append((start, len(text)))
    return [(s, e) for s, e in spans if e > s]


def _evidence(text: str, sentences: list[tuple[int, int]], position: int) -> str:
    """Evidence = the enclosing sentence, whitespace-normalized.

    Sentence-level evidence is more useful to an investigator than a fixed
    character window, and stays short because FIR narratives are 2-3 sentences.
    """
    if not sentences:
        return norm.normalize_whitespace(text)
    starts = [s for s, _ in sentences]
    idx = max(0, bisect_right(starts, position) - 1)
    s, e = sentences[idx]
    return norm.normalize_whitespace(text[s:e])


# Public aliases: the relationship extractor reuses the same sentence
# segmentation and evidence convention so spans stay consistent across outputs.
sentence_spans = _sentence_spans
evidence_for_position = _evidence


def evidence_for_span(text: str, sentences: list[tuple[int, int]], start: int, end: int) -> str:
    """Evidence for a span: every sentence the span touches, whitespace-normalized."""
    touched = [(s, e) for s, e in sentences if s < end and start < e]
    if not touched:
        return norm.normalize_whitespace(text[start:end])
    return norm.normalize_whitespace(text[touched[0][0] : touched[-1][1]])
