"""Application configuration.

Centralizes all settings (including the awkward, deeply-nested dataset path noted
in docs/architecture.md §DQ-9) so nothing is hard-coded across the codebase.
All values can be overridden via environment variables prefixed with ``CNA_``.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# --- Path anchors -----------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent          # .../backend/app
BACKEND_DIR = APP_DIR.parent                        # .../backend
REPO_ROOT = BACKEND_DIR.parent                      # .../AI-Criminal-Network-Analysis

# The provided dataset lives under a doubly-nested folder whose leaf name
# contains a space. Keep this in exactly one place.
DEFAULT_DATASET_DIR = (
    REPO_ROOT
    / "dataset"
    / "AI-Powered-Criminal-Network-Analysis-System-main"
    / "AI-Powered-Criminal-Network-Analysis-System-main"
    / "synthetic dataset"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CNA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Application metadata
    app_name: str = "AI-Powered Criminal Network Analysis API"
    app_version: str = "0.1.0"
    phase: str = "1 - Backend Foundation"
    environment: str = "development"

    # API
    api_v1_prefix: str = "/api/v1"

    # Data (read-only source)
    dataset_dir: Path = DEFAULT_DATASET_DIR
    # Optional enrichment (Phase 9) lives in a SEPARATE directory; originals untouched.
    enrichment_dir: Path = BACKEND_DIR / "data" / "enrichment"

    # CORS for local frontend development (Vite: 5173, CRA: 3000)
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # Logging
    log_level: str = "INFO"

    # Pagination
    default_page_size: int = 50
    max_page_size: int = 200

    # Geo normalization (canonical city centroid + deterministic jitter, §DQ-1)
    geo_jitter_degrees: float = 0.05

    # --- Phase 2: graph engine --------------------------------------------
    # Multiplex edge-weight coefficients for the UNDIRECTED person analytic
    # graph (centrality / community). These are transparent, tunable analytic
    # weights (edge strength) — NOT confidence values (see phase2_preflight §3).
    graph_weight_called: float = 1.0
    graph_weight_transacted: float = 1.0
    graph_weight_co_located: float = 0.5
    graph_weight_reported_against: float = 1.0
    # Coefficients for the DIRECTED person projection (PageRank / flow).
    graph_dir_weight_called: float = 1.0
    graph_dir_weight_transacted: float = 1.0
    graph_dir_weight_reported_against: float = 1.0
    # CO_LOCATED clique guard (§preflight watch-item 4): skip locations shared
    # by more than this many persons to avoid O(n^2) edge explosion.
    co_located_max_group: int = 30
    # Network expansion safety limits (§8: prevent unbounded expansion).
    graph_max_depth: int = 2
    graph_max_network_nodes: int = 300
    graph_max_path_length: int = 6
    graph_max_paths: int = 5
    graph_search_limit: int = 50
    # Analytics determinism / interpretation.
    louvain_seed: int = 42
    pagerank_damping: float = 0.85
    pagerank_tolerance: float = 1.0e-10
    pagerank_max_iter: int = 200
    analytics_top_percentile: float = 90.0
    analytics_default_top: int = 20
    analytics_max_top: int = 100

    # --- Phase 3: FIR narrative NLP ---------------------------------------
    # Result caps for the NLP endpoints (mirrors the Phase 2 limits pattern).
    nlp_search_limit: int = 50
    nlp_search_max_limit: int = 200
    # Entity resolution acceptance threshold: a candidate resolution below this
    # deterministic score is left UNRESOLVED (never silently merged).
    nlp_resolution_min_confidence: float = 0.5
    # Narrative relationships below this confidence are extracted and reported
    # but NOT integrated into the narrative graph (spec §7).
    nlp_relationship_min_confidence: float = 0.5
    # Bounded hop check used to report whether an accepted narrative edge merely
    # short-circuits an existing structured path (honest "adds no new
    # connectivity" accounting, spec §9).
    nlp_derivability_max_hops: int = 2

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors(cls, v):
        # Allow comma-separated string via env var (CNA_CORS_ORIGINS=a,b,c)
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
