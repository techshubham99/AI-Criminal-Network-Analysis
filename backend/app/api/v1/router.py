"""Aggregates all v1 routers."""
from fastapi import APIRouter

from app.api.v1.endpoints import (
    analytics,
    audit,
    calls,
    data,
    entities,
    firs,
    graph,
    ingest,
    intelligence,
    locations,
    nlp,
    persons,
    transactions,
)

api_router = APIRouter()
api_router.include_router(data.router, prefix="/data", tags=["data"])
api_router.include_router(persons.router, prefix="/persons", tags=["persons"])
api_router.include_router(calls.router, prefix="/calls", tags=["calls"])
api_router.include_router(transactions.router, prefix="/transactions", tags=["transactions"])
api_router.include_router(locations.router, prefix="/locations", tags=["locations"])
api_router.include_router(firs.router, prefix="/firs", tags=["firs"])
api_router.include_router(graph.router, prefix="/graph", tags=["graph"])
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])
api_router.include_router(nlp.router, prefix="/nlp", tags=["nlp"])
# Phase 4. Kept under its own prefix so the investigation-priority ranking is
# never confused with the Phase 2 centrality ranking under /analytics.
api_router.include_router(
    intelligence.router, prefix="/intelligence", tags=["intelligence"]
)
# Phase 4.6. The only write surface in the project, and the only place a record
# can enter the graph. Kept under its own prefix so "submitting a record" is
# never confused with the read-only endpoints above it.
api_router.include_router(ingest.router, prefix="/ingest", tags=["ingest"])
api_router.include_router(entities.router, prefix="/entities", tags=["entities"])
# Phase 5. The tamper-evident audit ledger: a local append-only SHA-256 hash
# chain, kept under its own prefix because it answers a different question from
# every other route — not "what does the data say" but "has the record of what
# we did been altered". No permissioned blockchain network is involved.
api_router.include_router(audit.router, prefix="/audit", tags=["audit"])
