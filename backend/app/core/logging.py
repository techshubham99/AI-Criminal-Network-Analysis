"""Structured logging with PII redaction.

Security requirement (docs/architecture.md §E): no raw sensitive data — Aadhaar
numbers or phone numbers — may appear in logs. A logging filter masks them on
every record before it is emitted, regardless of which module logged it.
"""
from __future__ import annotations

import logging
import re

from app.config import Settings

# 12-digit Aadhaar and +91-XXXXXXXXXX phone patterns.
_AADHAAR_RE = re.compile(r"\b\d{12}\b")
_PHONE_RE = re.compile(r"\+91-\d{10}")


class PIIRedactionFilter(logging.Filter):
    """Masks Aadhaar and Indian phone numbers in the final log message."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - defensive
            return True
        message = _PHONE_RE.sub("+91-XXXXXXXXXX", message)
        message = _AADHAAR_RE.sub(lambda m: m.group()[:4] + "XXXXXXXX", message)
        # Replace msg/args so downstream formatters use the redacted text.
        record.msg = message
        record.args = ()
        return True


def configure_logging(settings: Settings) -> None:
    """Attach PII redaction to all handlers and ensure a formatter exists.

    Non-destructive: we augment existing handlers (e.g. uvicorn's) rather than
    replacing them, and add one StreamHandler only if none is present.
    """
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)

    for handler in root.handlers:
        if not any(isinstance(f, PIIRedactionFilter) for f in handler.filters):
            handler.addFilter(PIIRedactionFilter())

    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )
        handler.addFilter(PIIRedactionFilter())
        root.addHandler(handler)

    logging.getLogger("app").setLevel(level)
