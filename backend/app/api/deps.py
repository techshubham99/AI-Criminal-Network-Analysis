"""Shared API dependencies: pagination and dataset/graph access."""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Query, Request

from app.core.errors import ServiceUnavailableError
from app.repositories.dataset import DatasetRepository

if TYPE_CHECKING:  # avoid importing graph stack at module load / for Phase 1 tests
    from app.graph.analytics import GraphAnalytics
    from app.graph.service import GraphService
    from app.nlp.service import NlpService

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


class PaginationParams:
    """Validated ``page`` / ``page_size`` query parameters.

    ``page`` is 1-based. Invalid values (page < 1, page_size out of range) are
    rejected by FastAPI with HTTP 422 before the handler runs.
    """

    def __init__(
        self,
        page: int = Query(1, ge=1, description="1-based page number"),
        page_size: int = Query(
            DEFAULT_PAGE_SIZE,
            ge=1,
            le=MAX_PAGE_SIZE,
            description=f"Items per page (1-{MAX_PAGE_SIZE})",
        ),
    ) -> None:
        self.page = page
        self.page_size = page_size
        self.offset = (page - 1) * page_size
        self.limit = page_size


def get_dataset(request: Request) -> DatasetRepository:
    """Return the dataset repository loaded at application startup."""
    repo = getattr(request.app.state, "dataset", None)
    if repo is None or repo.loaded_at is None:
        raise ServiceUnavailableError("Dataset is not loaded")
    return repo


def get_graph(request: Request) -> "GraphService":
    """Return the graph service built at application startup."""
    service = getattr(request.app.state, "graph", None)
    if service is None:
        raise ServiceUnavailableError("Graph is not built")
    return service


def get_analytics(request: Request) -> "GraphAnalytics":
    """Return the (cached) graph analytics computed at application startup."""
    return get_graph(request).analytics


def get_nlp(request: Request) -> "NlpService":
    """Return the Phase 3 NLP service built at application startup.

    Strictly additive like the graph service: if the NLP layer failed to build,
    only the ``/nlp`` routes degrade (503) — Phase 1 and Phase 2 stay available.
    """
    service = getattr(request.app.state, "nlp", None)
    if service is None:
        raise ServiceUnavailableError("NLP layer is not built")
    return service
