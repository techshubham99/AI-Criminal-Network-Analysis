"""Deterministic normalization and field validation for submitted records.

Every function is pure: same input, same output, no clock and no I/O. The
original submission is always kept beside the normalized form on the
:class:`~app.ingest.models.IngestRecord`, so normalization never destroys what
the caller actually sent (the same commitment Phase 3 makes for extracted text).

Value-level rules are reused from Phase 3 (:mod:`app.nlp.normalizer`,
:mod:`app.nlp.validators`) rather than restated, so a phone number means the
same thing whether it arrived in a FIR narrative or in a call record.

The normalized payload is what the record id is computed from, so anything
non-deterministic (a wall-clock timestamp, a dict ordering) must not reach it.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from app.config import Settings
from app.nlp import normalizer as norm
from app.nlp import validators as nlp_validators

# The dataset's own timestamp shape: `2026-08-16T18:18:39`. Accepted inputs are
# normalized INTO this, so live rows sort and compare against dataset rows.
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S"
_TIMESTAMP_INPUTS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M",
    "%d-%m-%Y %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
)

# Reference keys, in the order the ladder in `resolution.py` prefers them.
REFERENCE_KEYS = ("person_id", "phone", "aadhaar", "name")

# A plausible calendar range for an investigation record. Bounds a typo
# (year 202 or 20266) without consulting the clock: whether a source's own
# timestamp is "in the future" is not something this layer has the authority to
# judge, and a clock-dependent rule would make validation non-reproducible.
MIN_YEAR = 2000
MAX_YEAR = 2100


class FieldError(ValueError):
    """A single field-level normalization failure, with a short reason."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(f"{field}: {message}")
        self.field = field
        self.message = message


def normalize_timestamp(raw: Any, field: str) -> str:
    """Return an ISO ``YYYY-MM-DDTHH:MM:SS`` timestamp or raise.

    A timestamp with a ``Z``/offset suffix is accepted and its offset dropped
    rather than silently shifted: the dataset carries naive local timestamps and
    inventing a timezone conversion would be inventing a fact.
    """
    text = norm.normalize_whitespace(str(raw or ""))
    if not text:
        raise FieldError(field, "required")
    candidate = text[:-1] if text.endswith("Z") else text
    if len(candidate) > 19 and (candidate[19] in "+-"):
        candidate = candidate[:19]
    for fmt in _TIMESTAMP_INPUTS:
        try:
            parsed = datetime.strptime(candidate, fmt)
        except ValueError:
            continue
        if not MIN_YEAR <= parsed.year <= MAX_YEAR:
            raise FieldError(field, f"year {parsed.year} is outside {MIN_YEAR}-{MAX_YEAR}")
        return parsed.strftime(TIMESTAMP_FORMAT)
    raise FieldError(field, f"not a recognisable timestamp: {text!r}")


def normalize_iso_date(raw: Any, field: str) -> str:
    """Return an ISO ``YYYY-MM-DD`` date or raise."""
    text = norm.normalize_whitespace(str(raw or ""))
    if not text:
        raise FieldError(field, "required")
    value = norm.normalize_date(text)
    if not nlp_validators.is_iso_date(value):
        raise FieldError(field, f"not a recognisable date: {text!r}")
    if not MIN_YEAR <= int(value[:4]) <= MAX_YEAR:
        raise FieldError(field, f"year {value[:4]} is outside {MIN_YEAR}-{MAX_YEAR}")
    return value


def normalize_reference(raw: Any, field: str) -> dict[str, Any]:
    """Normalize one person reference to the identifiers it actually carries.

    At least one of ``person_id`` / ``phone`` / ``aadhaar`` / ``name`` must be
    present and usable. Nothing is inferred: a reference that carries only a
    name stays a name, and the resolver decides what that can be matched to.
    """
    if not isinstance(raw, dict):
        raise FieldError(field, "must be an object identifying a person")

    out: dict[str, Any] = {}

    person_id = raw.get("person_id")
    if person_id is not None and str(person_id).strip() != "":
        try:
            out["person_id"] = int(str(person_id).strip())
        except ValueError:
            raise FieldError(f"{field}.person_id", "must be an integer") from None
        if out["person_id"] <= 0:
            raise FieldError(f"{field}.person_id", "must be positive")

    phone = raw.get("phone")
    if phone is not None and str(phone).strip() != "":
        value = norm.normalize_phone(str(phone))
        if not nlp_validators.is_valid_phone10(value):
            raise FieldError(f"{field}.phone", "not a 10-digit Indian mobile number")
        out["phone"] = value

    aadhaar = raw.get("aadhaar", raw.get("aadhar"))
    if aadhaar is not None and str(aadhaar).strip() != "":
        value = norm.normalize_aadhaar(str(aadhaar))
        if not nlp_validators.is_valid_aadhaar(value):
            raise FieldError(f"{field}.aadhaar", "not a 12-digit Aadhaar number")
        out["aadhaar"] = value

    name = raw.get("name")
    if name is not None and str(name).strip() != "":
        value = norm.normalize_name(str(name))
        if not nlp_validators.is_plausible_person_name(value):
            raise FieldError(f"{field}.name", "not a plausible person name")
        out["name"] = value

    if not out:
        raise FieldError(
            field, "needs at least one of person_id, phone, aadhaar or name"
        )
    return out


def _positive_int(raw: Any, field: str, *, maximum: int) -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        raise FieldError(field, "must be an integer") from None
    if value <= 0:
        raise FieldError(field, "must be greater than zero")
    if value > maximum:
        raise FieldError(field, f"must not exceed {maximum}")
    return value


def _amount(raw: Any, field: str, *, maximum: float) -> float:
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        raise FieldError(field, "must be a number") from None
    if value <= 0:
        raise FieldError(field, "must be greater than zero")
    if value > maximum:
        raise FieldError(field, f"must not exceed {maximum:.0f}")
    # Two decimal places: the dataset's own amount precision.
    return round(value, 2)


def _place(raw: dict[str, Any], *, required: bool) -> dict[str, Any]:
    """Normalize a city/state pair. Coordinates are accepted but never invented."""
    city = norm.normalize_whitespace(str(raw.get("city") or ""))
    state = norm.normalize_whitespace(str(raw.get("state") or ""))
    location_id = raw.get("location_id")

    out: dict[str, Any] = {}
    if location_id is not None and str(location_id).strip() != "":
        try:
            out["location_id"] = int(str(location_id).strip())
        except ValueError:
            raise FieldError("location_id", "must be an integer") from None
    if city:
        out["city"] = city
    if state:
        out["state"] = state
    if required and not out:
        raise FieldError("location", "needs a location_id, or a city and state")
    if not required and not out:
        return {}
    if "location_id" not in out and not (city and state):
        raise FieldError("location", "a place given by name needs both city and state")
    return out


def normalize_call(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    return {
        "caller": normalize_reference(payload.get("caller"), "caller"),
        "callee": normalize_reference(payload.get("callee"), "callee"),
        "start_time": normalize_timestamp(payload.get("start_time"), "start_time"),
        "duration_sec": _positive_int(
            payload.get("duration_sec"),
            "duration_sec",
            maximum=settings.ingest_max_call_duration_sec,
        ),
        "cell_tower_id": (
            _positive_int(payload.get("cell_tower_id"), "cell_tower_id", maximum=10**9)
            if payload.get("cell_tower_id") not in (None, "")
            else None
        ),
    }


def normalize_transaction(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    mode = norm.normalize_whitespace(str(payload.get("mode") or "")).upper()
    if not mode:
        raise FieldError("mode", "required")
    reference = norm.normalize_whitespace(
        str(payload.get("bank_ref") or payload.get("reference_id") or "")
    )
    if not reference:
        raise FieldError("bank_ref", "a transaction reference is required")
    return {
        "sender": normalize_reference(payload.get("sender"), "sender"),
        "receiver": normalize_reference(payload.get("receiver"), "receiver"),
        "amount_inr": _amount(
            payload.get("amount_inr"), "amount_inr", maximum=settings.ingest_max_amount_inr
        ),
        "txn_time": normalize_timestamp(payload.get("txn_time"), "txn_time"),
        "mode": mode,
        "bank_ref": reference.upper(),
    }


def normalize_location(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    del settings  # no configurable limits apply to a location observation
    out: dict[str, Any] = {
        "person": normalize_reference(payload.get("person"), "person"),
        "place": _place(payload, required=True),
    }
    observed_at = payload.get("observed_at")
    if observed_at not in (None, ""):
        out["observed_at"] = normalize_timestamp(observed_at, "observed_at")
    return out


def normalize_fir(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    narrative = norm.normalize_whitespace(str(payload.get("narrative") or ""))
    if len(narrative) < settings.ingest_min_narrative_chars:
        raise FieldError(
            "narrative",
            f"must be at least {settings.ingest_min_narrative_chars} characters",
        )
    if len(narrative) > settings.ingest_max_narrative_chars:
        raise FieldError(
            "narrative",
            f"must not exceed {settings.ingest_max_narrative_chars} characters",
        )
    out: dict[str, Any] = {
        "date": normalize_iso_date(payload.get("date"), "date"),
        "complainant": normalize_reference(payload.get("complainant"), "complainant"),
        "narrative": narrative,
        "place": _place(payload, required=True),
    }
    # An FIR may name no accused yet; that is a real state of an investigation,
    # not a malformed record.
    if payload.get("accused") not in (None, "", {}):
        out["accused"] = normalize_reference(payload.get("accused"), "accused")
    return out


NORMALIZERS = {
    "CALL": normalize_call,
    "TRANSACTION": normalize_transaction,
    "LOCATION": normalize_location,
    "FIR": normalize_fir,
}


def normalize(source_type: str, payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    """Normalize one payload for ``source_type``; raises :class:`FieldError`."""
    normalizer = NORMALIZERS.get(source_type)
    if normalizer is None:  # pragma: no cover - guarded by the enum at the edge
        raise FieldError("source_type", f"unsupported source type {source_type!r}")
    return normalizer(payload, settings)


def reference_label(reference: dict[str, Any]) -> str:
    """A short, non-sensitive label for a reference (used in explanations).

    Deliberately does not echo a full phone or Aadhaar number back into a
    message that may be logged or streamed.
    """
    if "person_id" in reference:
        return f"person_id {reference['person_id']}"
    if "phone" in reference:
        return f"phone ending {str(reference['phone'])[-4:]}"
    if "aadhaar" in reference:
        return f"Aadhaar ending {str(reference['aadhaar'])[-4:]}"
    name: Optional[str] = reference.get("name")
    return f"name {name!r}" if name else "reference"
