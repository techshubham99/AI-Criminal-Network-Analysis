"""Aggregates all v1 routers."""
from fastapi import APIRouter

from app.api.v1.endpoints import (
    analytics,
    calls,
    data,
    firs,
    graph,
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
