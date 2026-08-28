"""Per-entity change history (/api/v1/entities).

One route, kept out of the ``/ingest`` prefix because the question it answers is
about an entity, not about a submission: *what live records have touched this
person or place, and did any of them move its priority?*

Entity ids are the prefixed form used everywhere else for cross-type references
— ``person:141``, ``location:12``, ``fir:301`` — not the bare row id.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path

from app.api.deps import get_ingest
from app.ingest.pipeline import IngestPipeline
from app.schemas.ingest import EntityChangesOut

router = APIRouter()


@router.get(
    "/{entity_id}/changes",
    response_model=EntityChangesOut,
    summary="Live records that touched this entity",
)
def entity_changes(
    entity_id: str = Path(
        ..., min_length=3, description='Prefixed entity id, e.g. "person:141"'
    ),
    pipeline: IngestPipeline = Depends(get_ingest),
) -> EntityChangesOut:
    """Oldest first. An entity with no live records returns an empty list, not a
    404: "nothing has changed" is a valid and useful answer."""
    return EntityChangesOut(**pipeline.changes(entity_id))
