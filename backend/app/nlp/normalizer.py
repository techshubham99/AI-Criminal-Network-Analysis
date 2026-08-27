"""Deterministic value normalization for extracted entities (Phase 3 spec §4).

Every function is pure and deterministic: it takes a raw substring and returns a
canonical form. The caller always keeps the original ``raw_text`` on the
:class:`~app.nlp.models.ExtractedEntity`; normalization output is stored
*alongside* it, never in place of it.

Rules:
* whitespace  -> collapsed, trimmed
* phone       -> digits only, national 10-digit number (drops +91 / 0 prefixes)
* aadhaar     -> 12 digits, no spaces
* date        -> ISO ``YYYY-MM-DD`` when parseable, else whitespace-normalized raw
* money       -> integer/decimal rupee string (commas + currency markers removed)
* name        -> whitespace-normalized, original casing preserved
* location    -> "City, State" with single spaces around the comma
"""
from __future__ import annotations

import re
from datetime import datetime

_WS_RE = re.compile(r"\s+")
_NON_DIGIT_RE = re.compile(r"\D")

# Date input formats we accept, tried in order. ISO first (the corpus format).
_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%d %b %Y",
    "%d %B %Y",
    "%b %d, %Y",
    "%B %d, %Y",
)


def normalize_whitespace(text: str) -> str:
    """Collapse internal whitespace runs to a single space and trim ends."""
    return _WS_RE.sub(" ", text).strip()


def normalize_phone(raw: str) -> str:
    """Return the national 10-digit number.

    Strips every non-digit, then drops a leading ``91`` country code or ``0``
    trunk prefix so ``"+91-98765-43210"`` and ``"09876543210"`` both normalize
    to ``"9876543210"``. If the result is not a clean 10-digit number the
    digits-only form is returned unchanged (the caller/validator decides).
    """
    digits = _NON_DIGIT_RE.sub("", raw)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits


def normalize_aadhaar(raw: str) -> str:
    """Return the 12-digit Aadhaar with all spaces/separators removed."""
    return _NON_DIGIT_RE.sub("", raw)


def normalize_date(raw: str) -> str:
    """Return an ISO ``YYYY-MM-DD`` date when parseable, else the trimmed raw."""
    candidate = normalize_whitespace(raw)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return candidate


def normalize_money(raw: str) -> str:
    """Return a bare numeric rupee string (currency markers and commas removed).

    ``"₹5,000"`` / ``"Rs. 5,000"`` / ``"INR 5000"`` / ``"5,000 rupees"`` all
    normalize to ``"5000"``; a trailing ``.00`` decimal is preserved.
    """
    m = re.search(r"\d[\d,]*(?:\.\d+)?", raw)
    if not m:
        return normalize_whitespace(raw)
    return m.group(0).replace(",", "")


def normalize_name(raw: str) -> str:
    """Whitespace-normalize a person name; original casing is preserved."""
    return normalize_whitespace(raw)


def normalize_location(raw: str) -> str:
    """Normalize a ``"City, State"`` string to single spaces around the comma."""
    parts = [normalize_whitespace(p) for p in raw.split(",")]
    return ", ".join(p for p in parts if p)
