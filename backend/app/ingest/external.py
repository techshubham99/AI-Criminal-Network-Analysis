"""External source adapters (spec §13).

**No external integration exists.** This project has no access to NCRB, CDR,
banking or telecom systems, and nothing here contacts a network. What follows is
an interface: a place a real, authorized integration could be attached later
without changing the ingestion pipeline, since any such source would have to
arrive at :meth:`SourceAdapter.fetch` and go through exactly the same validation,
resolution and decision gate as a manual submission.

Adapters are opt-in by name via ``CNA_INGEST_EXTERNAL_SOURCES``. With that
setting empty — the default, and the only configuration this prototype ships —
:func:`enabled_adapters` returns nothing and the internal ingestion APIs work in
full without any credential.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Iterable

from app.config import Settings
from app.ingest.models import SourceType


class SourceAdapter(ABC):
    """Turns some outside feed into submissions the pipeline can judge.

    An adapter never decides anything. It yields payloads in the same shape the
    HTTP endpoints accept; acceptance remains the pipeline's decision.
    """

    #: Short identifier used in `CNA_INGEST_EXTERNAL_SOURCES`.
    name: str = ""
    #: Which record kind this adapter produces.
    source_type: SourceType = SourceType.FIR

    @abstractmethod
    def available(self) -> bool:
        """True only when this adapter is genuinely configured and reachable."""

    @abstractmethod
    def fetch(self) -> Iterable[dict[str, Any]]:
        """Yield raw payloads. Must not transform or judge them."""


#: Adapters that ship with the project. Deliberately empty: an entry here would
#: be a claim of access, and there is none to claim.
REGISTRY: dict[str, type[SourceAdapter]] = {}


def enabled_adapters(settings: Settings) -> list[SourceAdapter]:
    """Instantiate the adapters named in settings that are actually available."""
    out: list[SourceAdapter] = []
    for name in settings.ingest_external_sources:
        adapter_cls = REGISTRY.get(name)
        if adapter_cls is None:
            continue
        adapter = adapter_cls()
        if adapter.available():
            out.append(adapter)
    return out


def status(settings: Settings) -> dict[str, Any]:
    """Reportable, non-boastful description of external connectivity."""
    configured = list(settings.ingest_external_sources)
    return {
        "configured": configured,
        "available": [a.name for a in enabled_adapters(settings)],
        "registry": sorted(REGISTRY),
        "note": (
            "No external system integration is configured. Ingestion works "
            "entirely from records submitted to this API; the project does not "
            "connect to NCRB, CDR, banking or telecom systems."
        ),
    }
