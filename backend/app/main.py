"""FastAPI application factory.

Wires together configuration, logging, error handling, CORS, the dataset
repository (loaded once at startup), the ``/health`` probe, and the versioned
``/api/v1`` router.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.config import Settings, get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.graph.service import build_graph_service
from app.nlp.service import build_nlp_service
from app.repositories.dataset import DatasetRepository
from app.schemas.common import HealthResponse, RootResponse

logger = logging.getLogger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = get_settings()
    configure_logging(settings)
    logger.info("Starting %s v%s (phase: %s)", settings.app_name, settings.app_version, settings.phase)

    repo = DatasetRepository(settings)
    repo.load()  # fail fast if the read-only dataset is missing/corrupt
    app.state.settings = settings
    app.state.dataset = repo

    # Phase 2: build the graph engine once, at startup (deterministic, cached).
    # Strictly additive: if the graph engine fails to build, Phase 1 endpoints
    # must stay fully available, so this is non-fatal. app.state.graph is left
    # None and the /graph & /analytics routes return 503 (via get_graph) rather
    # than the whole app — including Phase 1 — failing to start.
    try:
        app.state.graph = build_graph_service(repo, settings)
        logger.info("Graph engine ready (%d nodes, %d edges)",
                    app.state.graph.store.node_count(), app.state.graph.store.edge_count())
    except Exception:  # pragma: no cover - defensive; the build is deterministic
        logger.exception("Graph engine build failed; Phase 2 routes will return 503")
        app.state.graph = None

    # Phase 3: build the narrative NLP layer over the FIR text. Also strictly
    # additive and non-fatal. It READS the Phase 2 store and writes narrative
    # edges only into its own separate graph, so Phase 1/2 behaviour is unchanged.
    # Requires the graph (for the duplicate/derivability checks), so it is skipped
    # if the graph build failed and /nlp then returns 503 via get_nlp.
    app.state.nlp = None
    if app.state.graph is not None:
        try:
            app.state.nlp = build_nlp_service(repo, settings, app.state.graph.store)
            logger.info(
                "NLP layer ready (%d FIRs analysed, %d narrative edges)",
                app.state.nlp.fir_count,
                app.state.nlp.integrator.store.edge_count(),
            )
        except Exception:  # pragma: no cover - defensive; the build is deterministic
            logger.exception("NLP layer build failed; Phase 3 routes will return 503")
            app.state.nlp = None
    else:
        logger.warning("Graph unavailable; skipping NLP layer build (Phase 3 routes -> 503)")

    yield

    logger.info("Shutting down")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="Backend API for the AI-Powered Criminal Network Analysis System (SIH 2026, PS 26189).",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_error_handlers(app)
    app.include_router(api_router, prefix=settings.api_v1_prefix)

    @app.get("/health", response_model=HealthResponse, tags=["meta"], summary="Liveness/readiness probe")
    def health() -> HealthResponse:
        repo = getattr(app.state, "dataset", None)
        return HealthResponse(
            status="ok",
            app=settings.app_name,
            version=settings.app_version,
            phase=settings.phase,
            environment=settings.environment,
            dataset_loaded=bool(repo is not None and repo.loaded_at is not None),
        )

    @app.get("/", response_model=RootResponse, tags=["meta"], summary="Service root")
    def root() -> RootResponse:
        return RootResponse(
            app=settings.app_name,
            version=settings.app_version,
            phase=settings.phase,
            docs="/docs",
            health="/health",
            api_base=settings.api_v1_prefix,
        )

    return app


app = create_app()
