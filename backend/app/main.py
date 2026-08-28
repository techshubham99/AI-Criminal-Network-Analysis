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
from app.audit.service import build_audit_service
from app.config import Settings, get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.graph.service import build_graph_service
from app.ingest.pipeline import build_ingest_pipeline
from app.nlp.service import build_nlp_service
from app.repositories.dataset import DatasetRepository
from app.risk.service import build_intelligence_service
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

    # Phase 4: investigation intelligence. Additive in the same way — it reads
    # the built graph, the Phase 2 analytics and (where available) the Phase 3
    # narrative store, and a failure here degrades only the /intelligence routes.
    app.state.intelligence = None
    if app.state.graph is not None:
        try:
            app.state.intelligence = build_intelligence_service(
                repo,
                settings,
                app.state.graph.store,
                app.state.graph.analytics,
                narrative_store=(
                    app.state.nlp.integrator.store if app.state.nlp is not None else None
                ),
            )
            logger.info(
                "Intelligence engine ready (%d patterns, %d persons scored)",
                len(app.state.intelligence.patterns),
                app.state.intelligence.summary()["persons_scored"],
            )
        except Exception:  # pragma: no cover - defensive; the build is deterministic
            logger.exception(
                "Intelligence engine build failed; Phase 4 routes will return 503"
            )
            app.state.intelligence = None
    else:
        logger.warning(
            "Graph unavailable; skipping intelligence build (Phase 4 routes -> 503)"
        )

    # Phase 5: the tamper-evident audit ledger. Built *before* ingestion,
    # because the pipeline appends to it inside its own ingestion lock and a
    # pipeline that started without one would silently produce unaudited
    # decisions. Additive and non-fatal like every phase before it: a failure, or
    # CNA_AUDIT_ENABLED=false, degrades only the /audit routes to 503 and leaves
    # ingestion working — loudly unaudited rather than unavailable.
    app.state.audit = None
    if settings.audit_enabled:
        try:
            app.state.audit = build_audit_service(settings)
            logger.info(
                "Audit ledger ready (%s, persistence %s, %d event(s) loaded)",
                app.state.audit.ledger.backend_name,
                "on" if settings.audit_persist else "off",
                getattr(app.state.audit.ledger, "loaded", 0),
            )
        except Exception:  # pragma: no cover - defensive; the build is deterministic
            logger.exception("Audit ledger build failed; /audit routes will return 503")
            app.state.audit = None
    else:
        logger.warning("Audit ledger disabled by configuration (/audit -> 503)")

    # Phase 4.6: live ingestion. The only write path in the application, and the
    # only thing here that can change the graph after startup. Additive and
    # non-fatal like every phase before it: a failure degrades /ingest and
    # /entities/{id}/changes to 503 and leaves the read-only surface serving.
    #
    # It requires the graph, because there is nothing to update without one. The
    # `publish_intelligence` callback is how a recomputed Phase 4 engine reaches
    # the request path: the pipeline hands back a fresh IntelligenceService and
    # app.state.intelligence is swapped, so /intelligence responses reflect the
    # post-change graph rather than the startup snapshot.
    app.state.ingest = None
    if app.state.graph is not None:
        try:
            def publish_intelligence(service) -> None:
                app.state.intelligence = service

            app.state.ingest = build_ingest_pipeline(
                repo,
                settings,
                app.state.graph,
                app.state.nlp,
                app.state.intelligence,
                publish_intelligence=publish_intelligence,
                audit=app.state.audit,
            )
            logger.info(
                "Live ingestion ready (persistence %s, %d record(s) replayed)",
                "on" if settings.ingest_persist else "off",
                app.state.ingest.replayed,
            )
        except Exception:  # pragma: no cover - defensive; the build is deterministic
            logger.exception(
                "Live ingestion build failed; Phase 4.6 routes will return 503"
            )
            app.state.ingest = None
    else:
        logger.warning(
            "Graph unavailable; skipping live ingestion (Phase 4.6 routes -> 503)"
        )

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
